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
import {ensureExists} from '../../../base/assert';
import {loadScript} from '../../../base/dom_utils';
import {getErrorMessage} from '../../../base/errors';
import {
  errResult,
  okResult,
  type Result,
  type ErrorResult,
  type OkResult,
} from '../../../base/result';
import {loadGapiModules} from './gapi_utils';

// The Google API loader script, loaded once by GDriveClient.create().
const GAPI_LOADER_URL = 'https://apis.google.com/js/api.js';

// The Drive REST API endpoint for files.
const DRIVE_FILES_URL = 'https://www.googleapis.com/drive/v3/files';

// How long to wait for each network step of GDriveClient.create() before
// giving up. Without this a stalled request would never settle.
const INIT_STEP_TIMEOUT_MS = 30000;

const DRIVE_ID_RE = /^[a-zA-Z0-9_-]+$/;

// Validates a Google Drive file ID or resource key against the allowed
// character set to guard against path traversal or header/query injection.
export function isValidDriveId(id: string): boolean {
  return DRIVE_ID_RE.test(id);
}

export interface GDriveClientConfig {
  readonly apiKey: string;
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

// Talks to Google Drive: shows its file picker and downloads files.
export class GDriveClient {
  private constructor(private readonly config: GDriveClientConfig) {}

  // Loads everything the client needs and returns a ready-to-use client:
  // Google's API loader and its picker module, for the file picker. Rejects if
  // any step fails.
  //
  // Google's API client (gapi.client) is deliberately not loaded: Drive
  // requests are made with plain fetch() and the access token.
  //
  // Nothing here opens a popup or needs a user gesture, so this can run at
  // startup.
  static async create(config: GDriveClientConfig): Promise<GDriveClient> {
    await loadScript(GAPI_LOADER_URL, INIT_STEP_TIMEOUT_MS);
    await loadGapiModules('picker', INIT_STEP_TIMEOUT_MS);
    return new GDriveClient(config);
  }

  // Request access to a specific file by ID via the picker API.
  async requestFileAccess(
    oauthToken: string,
    fileId: string,
  ): Promise<google.picker.DocumentObject[] | undefined> {
    if (!isValidDriveId(fileId)) {
      return undefined;
    }
    const view = new google.picker.DocsView(google.picker.ViewId.DOCS)
      .setMode(google.picker.DocsViewMode.LIST)
      .setFileIds(fileId);
    const pickerResult = await this.picker(oauthToken, {view});
    return pickerResult?.docs;
  }

  // Open the Google Drive file picker to select a file.
  async pickFile(
    oauthToken: string,
  ): Promise<google.picker.DocumentObject[] | undefined> {
    const view = new google.picker.DocsView(google.picker.ViewId.DOCS).setMode(
      google.picker.DocsViewMode.LIST,
    );
    const pickerResult = await this.picker(oauthToken, {view});
    return pickerResult?.docs;
  }

  // Downloads a file's contents.
  async openFile(
    oauthToken: string,
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
        oauthToken,
        fileId,
        {alt: 'media'},
        resourceKey,
      );
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

  // Fetches a file's metadata (currently just its name). Returns undefined if
  // it cannot be fetched; this never rejects, as the metadata is only used for
  // display and should not stop a file from being opened.
  async getMeta(
    oauthToken: string,
    fileId: string,
    resourceKey?: string,
  ): Promise<GoogleDriveFileMeta | undefined> {
    if (!isValidDriveId(fileId)) return undefined;
    if (resourceKey !== undefined && !isValidDriveId(resourceKey)) {
      return undefined;
    }
    try {
      const response = await this.fetchFile(
        oauthToken,
        fileId,
        {fields: 'name'},
        resourceKey,
      );
      if (!response.ok) {
        console.warn(
          'Failed to fetch Google Drive file metadata',
          response.status,
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

  // Sends an authenticated GET for a file to the Drive REST API.
  private async fetchFile(
    oauthToken: string,
    fileId: string,
    params: Record<string, string>,
    resourceKey: string | undefined,
  ): Promise<Response> {
    const url = new URL(`${DRIVE_FILES_URL}/${encodeURIComponent(fileId)}`);
    for (const [key, value] of Object.entries(params)) {
      url.searchParams.set(key, value);
    }
    return await fetch(url, {
      headers: {
        Authorization: `Bearer ${oauthToken}`,
        ...resourceKeyHeaders(fileId, resourceKey),
      },
    });
  }

  private picker(
    oauthToken: string,
    config: PickerConfig,
  ): Promise<PickerResponse | undefined> {
    return new Promise<PickerResponse | undefined>((resolve, reject) => {
      const pickerBuilder = new google.picker.PickerBuilder()
        .setAppId(this.config.appId)
        .setOAuthToken(oauthToken)
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

// Google Drive's "Open with" deep link. When a user opens a file with Perfetto
// from the Drive UI, Drive loads our registered URL with ?state=<json> naming
// the file. This relies on the app being registered with Google Drive as an
// "Open with" app, with a redirect URI such as
// https://perfetto.dev/?state={...}.

// The shape of the JSON blob Google Drive passes as ?state=<url-encoded-json>.
const GDRIVE_OPEN_STATE_SCHEMA = z.object({
  // The IDs of the file(s) being opened.
  ids: z.array(z.string()).optional(),
  // The action being performed; 'open' for the "Open with" flow.
  action: z.string().optional(),
  // Maps file id -> resource key. The resource key is required to access a
  // file via the Drive API when the app is not a collaborator on it.
  resourceKeys: z.record(z.string(), z.string()).optional(),
});

export interface GDriveOpenFileRequest {
  readonly fileId: string;
  readonly resourceKey?: string;
}

export function parseGDriveStateParam(
  stateParam: string,
): Result<GDriveOpenFileRequest> {
  let raw: unknown;
  try {
    raw = JSON.parse(stateParam);
  } catch {
    // Not a GDrive "Open with" payload; ignore.
    return errResult('Invalid JSON');
  }

  const parsed = GDRIVE_OPEN_STATE_SCHEMA.safeParse(raw);
  if (!parsed.success) {
    return errResult('Invalid GDrive state');
  }

  const fileId = parsed.data.ids?.[0];

  if (!fileId) {
    return errResult('No file IDs provided');
  }

  if (!isValidDriveId(fileId)) {
    return errResult('Invalid file ID');
  }

  const resourceKey = parsed.data.resourceKeys?.[fileId];

  if (resourceKey !== undefined && !isValidDriveId(resourceKey)) {
    return errResult('Invalid resource key');
  }

  return okResult({fileId, resourceKey});
}
