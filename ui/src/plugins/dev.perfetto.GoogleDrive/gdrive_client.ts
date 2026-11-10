// Copyright (C) 2026 The Android Open Source Project
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//      http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

import {z} from 'zod';
import {ensureExists} from '../../base/assert';
import {getErrorMessage} from '../../base/errors';
import {
  errResult,
  okResult,
  type ErrorResult,
  type OkResult,
} from '../../base/result';

// The Google Drive / Google Identity Services loader scripts. These are loaded
// once, by GoogleDriveClient.create().
const GAPI_LOADER_URL = 'https://apis.google.com/js/api.js';
const GSI_CLIENT_URL = 'https://accounts.google.com/gsi/client';

// The Drive REST API endpoint for files.
const DRIVE_FILES_URL = 'https://www.googleapis.com/drive/v3/files';

// The Drive REST API endpoint for uploading a file with its metadata.
// supportsAllDrives lets the destination folder be in a shared drive; without
// it Drive reports such a folder as not found.
const DRIVE_UPLOAD_URL =
  'https://www.googleapis.com/upload/drive/v3/files' +
  '?uploadType=multipart&supportsAllDrives=true';

// How long to wait for each network step of GoogleDriveClient.create() before
// giving up. Without this a stalled request would never settle.
const INIT_STEP_TIMEOUT_MS = 30000;

// Loads an external <script>, resolving once it has loaded and rejecting if it
// fails to or takes too long.
function loadScript(src: string): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const script = document.createElement('script');
    const timer = setTimeout(() => {
      script.remove();
      reject(new Error(`Timed out loading ${src}`));
    }, INIT_STEP_TIMEOUT_MS);
    script.src = src;
    script.async = true;
    script.onload = () => {
      clearTimeout(timer);
      resolve();
    };
    script.onerror = () => {
      clearTimeout(timer);
      script.remove();
      reject(new Error(`Failed to load ${src}`));
    };
    document.head.append(script);
  });
}

// Loads one or more gapi modules (colon separated, e.g. 'picker:drive-share'),
// rejecting if they fail to load or take too long.
function loadGapiModules(modules: string): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    gapi.load(modules, {
      callback: () => resolve(),
      onerror: () => reject(new Error(`Failed to load gapi: ${modules}`)),
      timeout: INIT_STEP_TIMEOUT_MS,
      ontimeout: () => reject(new Error(`Timed out loading gapi: ${modules}`)),
    });
  });
}

const SCOPES =
  'https://www.googleapis.com/auth/drive.file https://www.googleapis.com/auth/drive.install';

const DRIVE_ID_RE = /^[a-zA-Z0-9_-]+$/;

// Validates a Google Drive file ID or resource key against the allowed
// character set to guard against path traversal or header/query injection.
export function isValidDriveId(id: string): boolean {
  return DRIVE_ID_RE.test(id);
}

export interface GoogleDriveConfig {
  readonly apiKey: string;
  readonly clientId: string;
  readonly appId: string;
}

interface PickerResponse {
  readonly docs: google.picker.DocumentObject[];
}

interface PickerConfig {
  readonly view: google.picker.DocsView;
  readonly title?: string;
}

interface GoogleDriveFileMeta {
  readonly name: string;
}

const FILE_META_SCHEMA = z.object({name: z.string()});

// What Drive returns for a successful upload: the new file's record.
const UPLOAD_RESPONSE_SCHEMA = z.object({id: z.string()});

export interface UploadOptions {
  // Called as the upload progresses, with the bytes sent so far and the total
  // to send. Both include a small amount of framing around the file itself.
  readonly onProgress?: (uploadedBytes: number, totalBytes: number) => void;
  // Abort this to cancel the upload.
  readonly signal?: AbortSignal;
}

export interface UploadError extends ErrorResult {
  // True if the upload was cancelled through UploadOptions.signal.
  readonly cancelled: boolean;
}

// The ID of the uploaded file, or why it could not be uploaded.
export type UploadResult = OkResult<string> | UploadError;

// The body of an error response from the Drive API.
const DRIVE_ERROR_SCHEMA = z.object({error: z.object({message: z.string()})});

// Extracts Drive's explanation from the body of an error response, if it has
// one.
function driveErrorMessage(responseText: string): string | undefined {
  let json: unknown;
  try {
    json = JSON.parse(responseText);
  } catch {
    return undefined;
  }
  const result = DRIVE_ERROR_SCHEMA.safeParse(json);
  return result.success ? result.data.error.message : undefined;
}

function uploadError(message: string, cancelled = false): UploadError {
  return {...errResult(message), cancelled};
}

// The resource key (from the "Open with" state payload) is required to access
// some link-shared files the user has not opened before. Drive expects it in
// the X-Goog-Drive-Resource-Keys header as "<fileId>/<resourceKey>".
function resourceKeyHeaders(
  fileId: string,
  resourceKey: string | undefined,
): Record<string, string> {
  if (resourceKey === undefined) return {};
  return {'X-Goog-Drive-Resource-Keys': `${fileId}/${resourceKey}`};
}

export interface OpenFileError extends ErrorResult {
  // True if Drive refused access to the file (HTTP 403 or 404). Drive reports
  // a file the app has not been granted access to as "not found", so this is
  // also true for files that do not exist.
  readonly accessDenied: boolean;
}

// The contents of the file, or why it could not be downloaded.
export type OpenFileResult = OkResult<ArrayBuffer> | OpenFileError;

// `status` is the HTTP status of Drive's response, if there was one.
function openFileError(message: string, status?: number): OpenFileError {
  return {
    ...errResult(message),
    accessDenied: status === 403 || status === 404,
  };
}

export type AuthenticationResponse =
  | {
      readonly response: 'success';
      readonly accessToken: string;
    }
  | {
      readonly response: 'popup_blocked';
    }
  | {
      readonly response: 'popup_closed';
    };

export class GoogleDriveClient {
  private pendingToken: Promise<AuthenticationResponse> | undefined;
  private accessToken: string | undefined;
  private tokenExpiresAtMs = 0;

  private constructor(private readonly config: GoogleDriveConfig) {}

  // Loads everything the client needs and returns a ready-to-use client:
  // Google's API loader with its picker and drive-share modules, for the file
  // picker and the sharing dialog, and Google Identity Services, for signing
  // in. Rejects if any step fails.
  //
  // Google's API client (gapi.client) is deliberately not loaded: Drive
  // requests are made with plain fetch() and the access token.
  //
  // Nothing here opens a popup or needs a user gesture, so this can run at
  // startup. Only authenticate() opens a popup.
  static async create(config: GoogleDriveConfig): Promise<GoogleDriveClient> {
    await loadScript(GAPI_LOADER_URL);
    await loadGapiModules('picker:drive-share');
    await loadScript(GSI_CLIENT_URL);
    if (window.google?.accounts?.oauth2 === undefined) {
      throw new Error('Google Identity Services is not available');
    }
    return new GoogleDriveClient(config);
  }

  // Request access to a specific file by ID via the picker API.
  async requestFileAccess(
    token: string,
    fileId: string,
  ): Promise<google.picker.DocumentObject[] | undefined> {
    if (!isValidDriveId(fileId)) {
      return undefined;
    }
    const view = new google.picker.DocsView(google.picker.ViewId.DOCS)
      .setMode(google.picker.DocsViewMode.LIST)
      .setFileIds(fileId);
    const pickerResult = await this.picker(token, {view});
    return pickerResult?.docs;
  }

  // Open the Google Drive file picker to select a file.
  async pickFile(
    token: string,
  ): Promise<google.picker.DocumentObject[] | undefined> {
    const view = new google.picker.DocsView(google.picker.ViewId.DOCS).setMode(
      google.picker.DocsViewMode.LIST,
    );
    const pickerResult = await this.picker(token, {view});
    return pickerResult?.docs;
  }

  // Pick a folder using the Google Drive file picker.
  async pickFolder(
    token: string,
  ): Promise<google.picker.DocumentObject | undefined> {
    const view = new google.picker.DocsView(google.picker.ViewId.FOLDERS)
      .setMode(google.picker.DocsViewMode.LIST)
      .setIncludeFolders(true)
      .setSelectFolderEnabled(true)
      .setMimeTypes('application/vnd.google-apps.folder');
    const pickerResult = await this.picker(token, {
      view,
      title: 'Select folder',
    });
    return pickerResult?.docs[0];
  }

  // Downloads a file's contents. Requires a prior successful authenticate().
  async openFile(
    fileId: string,
    resourceKey?: string,
  ): Promise<OpenFileResult> {
    if (!isValidDriveId(fileId)) {
      return openFileError('Invalid Google Drive file ID');
    }
    if (resourceKey !== undefined && !isValidDriveId(resourceKey)) {
      return openFileError('Invalid Google Drive resource key');
    }
    try {
      // 'alt=media' asks for the file's contents rather than its metadata. The
      // response is read straight into an ArrayBuffer, avoiding extra copies
      // of large traces.
      const response = await this.fetchFile(
        fileId,
        {alt: 'media'},
        resourceKey,
      );
      if (response === undefined) {
        return openFileError('Not signed in to Google Drive');
      }
      if (!response.ok) {
        return openFileError(
          `Google Drive returned HTTP ${response.status}`,
          response.status,
        );
      }
      return okResult(await response.arrayBuffer());
    } catch (error) {
      return openFileError(getErrorMessage(error));
    }
  }

  // Opens Drive's sharing settings dialog for a file. The drive-share module
  // it needs is loaded by create().
  openSharingDialog(token: string, fileId: string) {
    const shareClient = new gapi.drive.share.ShareClient();
    shareClient.setOAuthToken(token);
    shareClient.setItemIds([fileId]);
    shareClient.showSettingsDialog();
  }

  // Uploads a file to Drive, resolving with the new file's ID.
  //
  // This uses XMLHttpRequest rather than fetch(), as fetch() cannot report
  // upload progress. `opts.onProgress` is called as bytes are sent, and
  // aborting `opts.signal` cancels the upload.
  uploadFile(
    token: string,
    traceBlob: Blob,
    parentId: string,
    fileName: string,
    opts?: UploadOptions,
  ): Promise<UploadResult> {
    const metadata = {
      name: fileName,
      mimeType: 'application/octet-stream',
      parents: [parentId],
    };

    const boundary = '-------314159265358979323846';
    const delimiter = `\r\n--${boundary}\r\n`;
    const closeDelim = `\r\n--${boundary}--`;

    const metadataPart =
      delimiter +
      'Content-Type: application/json; charset=UTF-8\r\n\r\n' +
      JSON.stringify(metadata);

    const mediaPart =
      delimiter + 'Content-Type: application/octet-stream\r\n\r\n';

    // The trace is referenced by the body rather than copied into it.
    const body = new Blob([metadataPart, mediaPart, traceBlob, closeDelim]);

    return new Promise<UploadResult>((resolve) => {
      const signal = opts?.signal;
      if (signal?.aborted) {
        resolve(uploadError('Upload cancelled', true));
        return;
      }

      const req = new XMLHttpRequest();
      req.open('POST', DRIVE_UPLOAD_URL, /* async= */ true);
      req.setRequestHeader(
        'Content-Type',
        `multipart/related; boundary=${boundary}`,
      );
      req.setRequestHeader('Authorization', `Bearer ${token}`);

      req.upload.onprogress = (e: ProgressEvent) => {
        opts?.onProgress?.(e.loaded, e.total);
      };
      req.onabort = () => resolve(uploadError('Upload cancelled', true));
      req.onerror = () => resolve(uploadError('Network error'));
      req.onload = () => {
        if (req.status < 200 || req.status >= 300) {
          // Drive explains the failure (e.g. storage quota exceeded) in the
          // response body; pass that on if it is there.
          const reason = driveErrorMessage(req.responseText);
          resolve(
            uploadError(
              reason === undefined
                ? `Google Drive returned HTTP ${req.status}`
                : `${reason} (HTTP ${req.status})`,
            ),
          );
          return;
        }
        let json: unknown;
        try {
          json = JSON.parse(req.responseText);
        } catch {
          json = undefined;
        }
        const result = UPLOAD_RESPONSE_SCHEMA.safeParse(json);
        if (!result.success) {
          resolve(uploadError('Google Drive did not return a file ID'));
          return;
        }
        resolve(okResult(result.data.id));
      };

      signal?.addEventListener('abort', () => req.abort(), {once: true});
      req.send(body);
    });
  }

  // Fetches a file's metadata (currently just its name). Returns undefined if
  // it cannot be fetched; this never rejects, as the metadata is only used for
  // display and should not stop a file from being opened. Requires a prior
  // successful authenticate().
  async getMeta(
    fileId: string,
    resourceKey?: string,
  ): Promise<GoogleDriveFileMeta | undefined> {
    if (!isValidDriveId(fileId)) return undefined;
    if (resourceKey !== undefined && !isValidDriveId(resourceKey)) {
      return undefined;
    }
    try {
      const response = await this.fetchFile(
        fileId,
        {fields: 'name'},
        resourceKey,
      );
      if (response === undefined || !response.ok) {
        console.warn(
          'Failed to fetch Google Drive file metadata',
          response?.status,
        );
        return undefined;
      }
      const meta = FILE_META_SCHEMA.safeParse(await response.json());
      return meta.success ? meta.data : undefined;
    } catch (e) {
      console.warn('Failed to fetch Google Drive file metadata', e);
      return undefined;
    }
  }

  // Sends an authenticated GET for a file to the Drive REST API, using the
  // token from the last successful authenticate() call. Returns undefined if
  // there is no such token.
  private async fetchFile(
    fileId: string,
    params: Record<string, string>,
    resourceKey: string | undefined,
  ): Promise<Response | undefined> {
    const accessToken = this.accessToken;
    if (accessToken === undefined) return undefined;
    const url = new URL(`${DRIVE_FILES_URL}/${encodeURIComponent(fileId)}`);
    for (const [key, value] of Object.entries(params)) {
      url.searchParams.set(key, value);
    }
    const response = await fetch(url, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        ...resourceKeyHeaders(fileId, resourceKey),
      },
    });
    if (response.status === 401) {
      // The token was revoked, or expired earlier than expected. Forget it, so
      // that the next authenticate() asks for a new one rather than handing
      // this one out again.
      this.accessToken = undefined;
    }
    return response;
  }

  // Returns an access token, asking the user to sign in if there is no valid
  // one. Signing in opens a popup, which browsers only allow from a user
  // gesture, so nothing is awaited here before the popup is requested.
  authenticate(): Promise<AuthenticationResponse> {
    if (this.accessToken !== undefined && Date.now() < this.tokenExpiresAtMs) {
      return Promise.resolve({
        response: 'success',
        accessToken: this.accessToken,
      });
    }

    // Share a single sign-in between concurrent callers, and forget it once it
    // settles so that a later call can try again.
    if (this.pendingToken === undefined) {
      this.pendingToken = this.requestToken().finally(() => {
        this.pendingToken = undefined;
      });
    }
    return this.pendingToken;
  }

  private requestToken(): Promise<AuthenticationResponse> {
    return new Promise<AuthenticationResponse>((resolve, reject) => {
      // The google.accounts.oauth2 token client is typed via the Window
      // augmentation in google_drive.d.ts.
      const oauth2 = window.google?.accounts?.oauth2;
      if (oauth2 === undefined) {
        reject(new Error('Google Identity Services is not available'));
        return;
      }
      const tokenClient: GDriveTokenClient = oauth2.initTokenClient({
        client_id: this.config.clientId,
        scope: SCOPES,
        callback: (tokenResponse: GDriveTokenResponse) => {
          const error = tokenResponse.error;
          if (typeof error === 'string' && error !== '') {
            reject(new Error(error));
            return;
          }
          const accessToken = tokenResponse.access_token;
          if (typeof accessToken !== 'string') {
            reject(new Error('No access token returned'));
            return;
          }
          const parsedExpires = Number(tokenResponse.expires_in);
          const expiresInSec = Number.isFinite(parsedExpires)
            ? parsedExpires
            : 3600;
          this.accessToken = accessToken;
          this.tokenExpiresAtMs =
            Date.now() + Math.max(0, expiresInSec - 60) * 1000;
          resolve({response: 'success', accessToken});
        },
        error_callback: (error: GDriveTokenClientError) => {
          if (error.type === 'popup_failed_to_open') {
            resolve({response: 'popup_blocked'});
          } else if (error.type === 'popup_closed') {
            resolve({response: 'popup_closed'});
          } else {
            reject(new Error(`Google sign-in failed: ${error.type}`));
          }
        },
      });
      tokenClient.requestAccessToken({prompt: ''});
    });
  }

  private picker(
    token: string,
    config: PickerConfig,
  ): Promise<PickerResponse | undefined> {
    return new Promise<PickerResponse | undefined>((resolve, reject) => {
      const pickerBuilder = new google.picker.PickerBuilder()
        .setAppId(this.config.appId)
        .setOAuthToken(token)
        .setDeveloperKey(this.config.apiKey)
        .setOrigin(window.location.origin)
        .addView(config.view)
        .setCallback((data) => {
          // Anything thrown in here would otherwise be lost, leaving the
          // promise pending for ever.
          try {
            switch (data.action) {
              case google.picker.Action.PICKED:
                resolve({docs: ensureExists(data.docs)});
                break;
              case google.picker.Action.CANCEL:
                resolve(undefined);
                break;
              case google.picker.Action.ERROR:
                reject(new Error('Something went wrong with the picker'));
                break;
            }
          } catch (e) {
            reject(e);
          }
        });

      if (config.title !== undefined) {
        pickerBuilder.setTitle(config.title);
      }

      const picker = pickerBuilder.build();
      picker.setVisible(true);
    });
  }
}
