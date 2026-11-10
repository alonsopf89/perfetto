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

import m from 'mithril';
import {z} from 'zod';
import type {App} from '../../public/app';
import type {Flag} from '../../public/feature_flag';
import type {PerfettoPlugin} from '../../public/plugin';
import type {RouteArgs} from '../../public/route_schema';
import type {Trace} from '../../public/trace';
import {Button, ButtonVariant} from '../../widgets/button';
import {closeModal, showModal} from '../../widgets/modal';
import {Stack} from '../../widgets/stack';
import {
  GoogleDriveClient,
  isValidDriveId,
  type AuthenticationResponse,
  type GoogleDriveConfig,
  type OpenFileResult,
  type UploadResult,
} from './gdrive_client';
import {errResult} from '../../base/result';
import {getErrorMessage} from '../../base/errors';
import {Intent} from '../../widgets/common';
import {ShareForm, type ShareState, type UploadState} from './share_form';
import './styles.scss';

// The Google Drive credentials are not checked into the repo. They are fetched
// at runtime as a JSON blob from a public GCS bucket (which has CORS enabled).
const CONFIG_URL =
  'https://storage.googleapis.com/perfetto-misc/gdrive_config.json';
const CONFIG_LOAD_TIMEOUT_MS = 5000;

const GDRIVE_CONFIG_SCHEMA = z.object({
  apiKey: z.string(),
  clientId: z.string(),
  appId: z.string(),
});

// Fetches and validates the config, throwing on any error (network failure,
// timeout, bad status, or schema mismatch).
async function loadGDriveConfig(): Promise<GoogleDriveConfig> {
  try {
    // Kept in GCS rather than hardcoded so we can rotate keys, migrate Cloud
    // projects, or kill the integration across all release channels in
    // lockstep without shipping a new build.
    const response = await fetch(CONFIG_URL, {
      signal: AbortSignal.timeout(CONFIG_LOAD_TIMEOUT_MS),
    });
    if (!response.ok) {
      throw new Error(
        `Failed to fetch Google Drive config: ${response.status}`,
      );
    }
    const result = GDRIVE_CONFIG_SCHEMA.safeParse(await response.json());
    if (!result.success) {
      throw new Error('Invalid Google Drive config', {cause: result.error});
    }
    return result.data;
  } catch (e) {
    throw new Error('Failed to load Google Drive config', {cause: e});
  }
}

// Loads everything Google Drive support needs, in order: the config, Google's
// scripts and the picker module. This runs once, at startup, and
// nothing in it opens a popup.
//
// Returns undefined if any step fails. This is deliberately quiet (a console
// error only): it runs on every page load, including for users who are offline
// or block Google's scripts and never asked for Google Drive. The sidebar
// button stays hidden and the "Open with" deep link reports that Google Drive
// is unavailable.
async function initGDrive(): Promise<GoogleDriveClient | undefined> {
  try {
    const config = await loadGDriveConfig();
    return await GoogleDriveClient.create(config);
  } catch (e) {
    console.error('Failed to initialize Google Drive', e);
    return undefined;
  }
}

// The "Open with" deep link (?state=<json>) is handled by
// handleOpenWithState() below. It relies on the app being registered with
// Google Drive as an "Open with" app, with a redirect URI such as
// https://perfetto.dev/?state={...} where the JSON blob names the file to open.

// What this plugin attaches to a trace it opens from Drive, through the
// pluginArgs of openTraceFromBuffer(), and reads back in onTraceLoad(). It
// travels with that one trace, so it cannot end up on a different one.
//
// A trace handed to the UI by another site (via postMessage) can carry plugin
// args too, so what arrives is validated like any other untrusted input.
const TRACE_ARGS_SCHEMA = z.object({
  // The Drive file ID the trace was opened from.
  fileId: z.string().refine(isValidDriveId),
});

export default class GoogleDrivePlugin implements PerfettoPlugin {
  static readonly id = 'dev.perfetto.GoogleDrive';
  static readonly description = 'Open and save traces to Google Drive';

  // What the "Share to Google Drive" dialog shows for this trace. It lives
  // here, on the per-trace plugin instance, rather than in the dialog, so that
  // an upload carries on being shown, cancellable and able to report failure
  // if the dialog is closed and reopened.
  private readonly share: ShareState = {
    fileName: '',
    location: 'root',
    fileId: undefined,
    upload: undefined,
    error: undefined,
  };

  // The client, once initGDrive() has succeeded. Stays undefined if it fails.
  static client: GoogleDriveClient | undefined;

  // Development aids for manually testing the failure handling UI. See
  // README.md in this directory. Registered in onActivate().
  static mockAuthFailureFlag: Flag;
  static mockDownloadFailureFlag: Flag;

  // Shows the Google Drive buttons to users who are not internal, so the
  // feature can be tried with external accounts ahead of a wider launch.
  // Registered in onActivate().
  static allowExternalUsersFlag: Flag;

  // Whether the Google Drive buttons may be shown to the current user. This
  // can change after startup, as isInternalUser is resolved asynchronously.
  static isUserAllowed(app: App): boolean {
    return app.isInternalUser || GoogleDrivePlugin.allowExternalUsersFlag.get();
  }

  static onActivate(app: App, pluginArgs: RouteArgs) {
    GoogleDrivePlugin.allowExternalUsersFlag = app.featureFlags.register({
      id: 'dev.perfetto.GoogleDriveAllowExternalUsers',
      name: 'Google Drive for external users',
      description:
        'Shows the Google Drive buttons to users who are not internal. For ' +
        'testing ahead of launch.',
      defaultValue: false,
    });
    GoogleDrivePlugin.mockAuthFailureFlag = app.featureFlags.register({
      id: 'dev.perfetto.GoogleDriveMockAuthFailure',
      name: 'Development: Google Drive mock sign-in failure',
      description:
        'Makes every Google Drive sign-in attempt fail, to test the error ' +
        'handling UI.',
      defaultValue: false,
      devOnly: true,
    });
    GoogleDrivePlugin.mockDownloadFailureFlag = app.featureFlags.register({
      id: 'dev.perfetto.GoogleDriveMockDownloadFailure',
      name: 'Development: Google Drive mock download/upload failure',
      description:
        'Makes every Google Drive file download and upload fail, to test ' +
        'the error handling UI.',
      defaultValue: false,
      devOnly: true,
    });

    const clientPromise = initGDrive();
    clientPromise.then((c) => {
      GoogleDrivePlugin.client = c;
      app.raf.scheduleFullRedraw();
    });

    app.sidebar.addMenuItem({
      section: 'trace_files',
      text: 'Open from GDrive',
      icon: 'drive_export',
      badge: 'preview',
      // Just below "Open trace file".
      sortOrder: 1.25,
      // Only expose the sidebar button to allowed users (see isUserAllowed()),
      // and only once everything it needs has loaded. This is a callback as
      // both are only resolved some time after startup.
      visible: () =>
        GoogleDrivePlugin.isUserAllowed(app) &&
        GoogleDrivePlugin.client !== undefined,
      action: async () => {
        const client = GoogleDrivePlugin.client;
        if (client === undefined) return;
        await pickAndOpenGDriveTrace(app, client);
      },
    });

    // When opening a trace directly from Google drive's UI, it passes the
    // file id and the resource keys in a hard-coded arg called 'state'.
    // Intercept this and load the file if these args are passed.
    const state = app.initialRouteArgs['state'];

    if (state !== undefined && typeof state === 'string') {
      handleOpenWithState(app, clientPromise, state);
    }

    // ?openFileId= share links, generated by the ShareForm.
    const openFileId = pluginArgs['openFileId'];

    if (openFileId !== undefined && typeof openFileId === 'string') {
      handleOpenFileId(app, clientPromise, openFileId);
    }
  }

  async onTraceLoad(
    trace: Trace,
    args?: {[key: string]: unknown},
  ): Promise<void> {
    const share = this.share;
    share.fileName = trace.traceInfo.traceTitle;
    const traceArgs = TRACE_ARGS_SCHEMA.safeParse(args);
    if (traceArgs.success) {
      // The trace was opened from Drive, so it is already there.
      share.fileId = traceArgs.data.fileId;
    }

    // Stop an upload that is still running when the trace is closed. Nothing
    // could show or cancel it any more, and it would keep the trace's contents
    // alive until it finished.
    trace.trash.defer(() => share.upload?.controller.abort());

    // The button reflects the share state, so that an upload can be followed,
    // and its outcome seen, while the dialog is closed. These callbacks run on
    // every render, and the upload's progress reports trigger a redraw.
    trace.sidebar.addMenuItem({
      section: 'current_trace',
      text: () =>
        isSavedToDrive(share) ? 'Saved to GDrive' : 'Share to GDrive',
      icon: () => {
        if (share.upload !== undefined) return 'add_to_drive';
        if (isSavedToDrive(share)) return 'cloud_done';
        // The last action in the share dialog failed.
        if (share.error !== undefined) return 'error';
        return 'add_to_drive';
      },
      sortOrder: 10,
      // While uploading, the badge shows how far the upload has got.
      badge: () => {
        const upload = share.upload;
        if (upload === undefined) return 'preview';
        if (upload.totalBytes === 0) return '…';
        return `${Math.floor((100 * upload.uploadedBytes) / upload.totalBytes)}%`;
      },
      // Only for allowed users (see isUserAllowed()), only once everything has
      // loaded, and only for traces whose contents can be read back to upload
      // (not, for example, one loaded over HTTP+RPC).
      visible: () =>
        GoogleDrivePlugin.isUserAllowed(trace) &&
        GoogleDrivePlugin.client !== undefined &&
        trace.traceInfo.downloadable,
      action: () => {
        const client = GoogleDrivePlugin.client;
        if (client === undefined) return;
        // This button opens a modal dialog which displays the state of the file
        // in google drive allowing the user to upload it and optionally share
        // it. The dialog renders this.share, and keeps no state of its own.
        showModal({
          key: 'GDriveUpload',
          title: 'Share to Google Drive',
          icon: 'cloud_upload',
          content: () =>
            m(ShareForm, {
              state: share,
              onFileNameChange: (fileName: string) => {
                share.fileName = fileName;
              },
              onUpload: () => void this.upload(trace, client),
              onCancelUpload: () => share.upload?.controller.abort(),
              onPickFolder: () => void this.pickFolder(client),
              onOpenSharingDialog: () => void this.openSharingDialog(client),
            }),
        });
      },
    });
  }

  // Runs an action started from the share dialog. A failure is recorded in
  // this.share.error, which the dialog shows in a banner, rather than being
  // allowed to escape. The action reports failure by throwing an Error with a
  // message for the user.
  private async runShareAction(action: () => Promise<void>): Promise<void> {
    this.share.error = undefined;
    try {
      await action();
    } catch (e) {
      console.error('Google Drive share action failed', e);
      this.share.error = getErrorMessage(e);
    } finally {
      // These actions finish outside of any DOM event handler.
      m.redraw();
    }
  }

  // Uploads the trace to Drive. Progress and the outcome are recorded in
  // this.share, so they are shown whenever the dialog is open.
  private async upload(trace: Trace, client: GoogleDriveClient): Promise<void> {
    const share = this.share;
    if (share.fileName === '' || share.upload !== undefined) return;

    // Fix the name and destination now: the upload outlives this click.
    const fileName = share.fileName;
    const parentId = share.location === 'root' ? 'root' : share.location.id;
    const upload: UploadState = {
      controller: new AbortController(),
      uploadedBytes: 0,
      totalBytes: 0,
    };
    const signal = upload.controller.signal;
    share.upload = upload;

    await this.runShareAction(async () => {
      const accessToken = await authenticateForShare(client);
      // The user may have cancelled while the sign-in popup was open.
      if (signal.aborted) return;
      let traceBlob: Blob;
      try {
        traceBlob = await trace.getTraceFile();
      } catch (e) {
        console.error('Failed to read the trace for upload', e);
        throw new Error(
          'This trace cannot be uploaded, as its contents are not available.',
        );
      }
      const result: UploadResult =
        GoogleDrivePlugin.mockDownloadFailureFlag.get()
          ? {
              ...errResult(
                'Mock failure (Google Drive mock download/upload failure ' +
                  'flag)',
              ),
              cancelled: false,
            }
          : await client.uploadFile(
              accessToken,
              traceBlob,
              parentId,
              fileName,
              {
                signal,
                onProgress: (uploadedBytes, totalBytes) => {
                  upload.uploadedBytes = uploadedBytes;
                  upload.totalBytes = totalBytes;
                  m.redraw();
                },
              },
            );
      if (!result.ok) {
        // Cancelling is the user's choice, not a failure.
        if (result.cancelled) return;
        throw new Error(
          `Couldn't upload the trace to Google Drive: ${result.error}`,
        );
      }
      share.fileId = result.value;
    });

    share.upload = undefined;
    m.redraw();
  }

  // Lets the user choose which Drive folder to upload to.
  private async pickFolder(client: GoogleDriveClient): Promise<void> {
    await this.runShareAction(async () => {
      const accessToken = await authenticateForShare(client);
      let newLocation: google.picker.DocumentObject | undefined;
      try {
        newLocation = await client.pickFolder(accessToken);
      } catch (e) {
        console.error('Failed to open the folder picker', e);
        throw new Error("Couldn't open the Google Drive folder picker.");
      }
      if (newLocation !== undefined) {
        this.share.location = newLocation;
      }
    });
  }

  // Opens Drive's sharing settings for the uploaded file.
  private async openSharingDialog(client: GoogleDriveClient): Promise<void> {
    const fileId = this.share.fileId;
    if (fileId === undefined || fileId === '') return;
    await this.runShareAction(async () => {
      const accessToken = await authenticateForShare(client);
      try {
        client.openSharingDialog(accessToken, fileId);
      } catch (e) {
        console.error('Failed to open the sharing dialog', e);
        throw new Error("Couldn't open the Google Drive sharing dialog.");
      }
    });
  }
}

// The shape of the JSON blob Google Drive posts to our registered "Open with"
// redirect URL as ?state=<url-encoded-json> when a user opens a file in our
// app directly from the Drive UI.
const GDRIVE_OPEN_STATE_SCHEMA = z.object({
  // The IDs of the file(s) being opened.
  ids: z.array(z.string()).optional(),
  // The action being performed; 'open' for the "Open with" flow.
  action: z.string().optional(),
  // Maps file id -> resource key. The resource key is required to access a
  // file via the Drive API when the app is not a collaborator on it.
  resourceKeys: z.record(z.string(), z.string()).optional(),
});

// Downloads a file from Google Drive and opens it as a trace.
//
// `opts.name` is the file's name if the caller already knows it (the picker
// reports it). Otherwise it is looked up from Drive alongside the download, as
// the "Open with" deep link only gives us the file ID.
async function openGDriveTrace(
  app: App,
  client: GoogleDriveClient,
  fileId: string,
  opts?: {name?: string; resourceKey?: string},
): Promise<OpenFileResult> {
  const knownName = opts?.name;
  const namePromise: Promise<string | undefined> =
    knownName !== undefined
      ? Promise.resolve(knownName)
      : client.getMeta(fileId, opts?.resourceKey).then((meta) => meta?.name);
  const filePromise: Promise<OpenFileResult> =
    GoogleDrivePlugin.mockDownloadFailureFlag.get()
      ? Promise.resolve({
          ...errResult(
            'Mock failure (Google Drive mock download failure flag)',
          ),
          accessDenied: false,
        })
      : client.openFile(fileId, opts?.resourceKey);
  // Neither of these reject: both report failure through their result.
  const [name, fileResult] = await Promise.all([namePromise, filePromise]);
  if (fileResult.ok) {
    // Fall back to a generic name if Drive could not tell us the real one.
    const traceName = name ?? 'Google Drive Trace';
    app.openTraceFromBuffer({
      buffer: fileResult.value,
      title: traceName,
      fileName: traceName,
      // ACL-protected Drive traces must not be re-uploaded to the public
      // perfetto-ui-data GCS bucket via permalinks or crash reports.
      shareable: false,
      // Lets onTraceLoad() know which Drive file this trace is.
      pluginArgs: {[GoogleDrivePlugin.id]: {fileId}},
    });
  }
  return fileResult;
}

// Whether the trace is known to be in Drive, either uploaded or opened from
// there.
function isSavedToDrive(share: Readonly<ShareState>): boolean {
  return share.fileId !== undefined && share.fileId !== '';
}

// Signs in for an action started from the "Share to Google Drive" dialog,
// returning the access token. Unlike authenticateOrPrompt() this shows no
// dialog of its own, as that would replace the share dialog: it throws an
// Error with a message for the user instead, which the share dialog shows in
// a banner. The user retries by pressing the same button again, which is a
// click, so the sign-in popup is allowed.
//
// Nothing is awaited before client.authenticate() is called, so that the popup
// is still attributed to the click that started the action.
async function authenticateForShare(
  client: GoogleDriveClient,
): Promise<string> {
  let auth: AuthenticationResponse;
  try {
    if (GoogleDrivePlugin.mockAuthFailureFlag.get()) {
      throw new Error('Mock failure (Google Drive mock sign-in failure flag)');
    }
    auth = await client.authenticate();
  } catch (e) {
    throw new Error(`Signing in to Google Drive failed: ${getErrorMessage(e)}`);
  }
  switch (auth.response) {
    case 'success':
      return auth.accessToken;
    case 'popup_blocked':
      throw new Error(
        'The Google sign-in window was blocked. Allow pop-ups for this site ' +
          'and try again.',
      );
    case 'popup_closed':
      throw new Error(
        'The Google sign-in window was closed before sign-in completed.',
      );
  }
}

// Sidebar flow: authenticate, let the user pick a file, then open it.
async function pickAndOpenGDriveTrace(
  app: App,
  client: GoogleDriveClient,
): Promise<void> {
  const accessToken = await authenticateOrPrompt(client, () =>
    pickAndOpenGDriveTrace(app, client),
  );
  if (accessToken === undefined) return;

  let files: google.picker.DocumentObject[] | undefined;
  try {
    files = await client.pickFile(accessToken);
  } catch (e) {
    showPickerFailedModal(e);
    return;
  }
  const firstFile = files?.[0];
  if (!firstFile) return;

  const fileResult = await openGDriveTrace(app, client, firstFile.id, {
    name: firstFile.name,
  });
  if (!fileResult.ok) {
    showDownloadFailedModal(fileResult.error);
  }
}

// Tells the user the file picker could not be shown. Cancelling the picker is
// not a failure and does not end up here.
function showPickerFailedModal(error: unknown) {
  console.error('Failed to open the Google Drive file picker', error);
  showModal({
    key: 'GoogleDrivePickerFailed',
    title: "Couldn't open the Google Drive file picker",
    content: m('p', 'The Google Drive file picker could not be opened.'),
    buttons: [{text: 'OK', primary: true}],
  });
}

// Tells the user a download failed. There is deliberately no retry: a second
// attempt is unlikely to succeed where the first did not.
function showDownloadFailedModal(error: unknown) {
  console.error('Failed to download file from Google Drive', error);
  showModal({
    key: 'GoogleDriveDownloadFailed',
    title: "Couldn't open file from Google Drive",
    content: m('p', 'The file could not be downloaded from Google Drive.'),
    buttons: [{text: 'OK', primary: true}],
  });
}

// Authenticates and returns the access token. If authentication does not
// succeed, shows a dialog that lets the user retry and returns undefined. The
// retry runs from a click handler, where the sign-in popup is allowed.
//
// Nothing is awaited before client.authenticate() is called, so that when this
// runs from a click the popup is still attributed to that click.
async function authenticateOrPrompt(
  client: GoogleDriveClient,
  retry: () => Promise<void>,
): Promise<string | undefined> {
  let auth: AuthenticationResponse;
  try {
    if (GoogleDrivePlugin.mockAuthFailureFlag.get()) {
      throw new Error('Mock failure (Google Drive mock sign-in failure flag)');
    }
    auth = await client.authenticate();
  } catch (e) {
    showSignInFailedModal(
      `Signing in to Google Drive failed: ${getErrorMessage(e)}`,
      retry,
    );
    return undefined;
  }

  switch (auth.response) {
    case 'success':
      return auth.accessToken;
    case 'popup_blocked':
      // Browsers block the sign-in popup when it is not opened from a user
      // gesture (e.g. when following an "Open with" deep link).
      showModal({
        key: 'GoogleDriveSignIn',
        title: 'Sign in to Google Drive',
        content: [
          m(
            'p',
            'To open a trace from Google Drive, sign in with your Google account.',
          ),
          m(
            'p',
            'To skip this step in future, allow pop-ups for this site in your browser settings.',
          ),
        ],
        buttons: [
          {text: 'Sign in', primary: true, action: retry},
          {text: 'Cancel'},
        ],
      });
      return undefined;
    case 'popup_closed':
      showSignInFailedModal(
        'The Google sign-in window was closed before sign-in completed.',
        retry,
      );
      return undefined;
  }
}

function showSignInFailedModal(message: string, retry: () => Promise<void>) {
  showModal({
    key: 'GoogleDriveSignInFailed',
    title: "Couldn't sign in to Google Drive",
    content: m('p', message),
    buttons: [
      {text: 'Try again', primary: true, action: retry},
      {text: 'Cancel'},
    ],
  });
}

// Authenticate (prompting the user to retry if that fails) and open the trace,
// falling back to an "authorize file access" prompt if the initial fetch fails.
async function openGDriveTraceWithAuth(
  app: App,
  client: GoogleDriveClient,
  fileId: string,
  resourceKey?: string,
): Promise<void> {
  const accessToken = await authenticateOrPrompt(client, () =>
    openGDriveTraceWithAuth(app, client, fileId, resourceKey),
  );
  if (accessToken === undefined) return;

  const fileResult = await openGDriveTrace(app, client, fileId, {
    resourceKey,
  });
  if (fileResult.ok) return;

  if (!fileResult.accessDenied) {
    showDownloadFailedModal(fileResult.error);
    return;
  }

  // Drive refused access to the file. The app can only read files the user has
  // opened or picked with it, so ask the user to authorize this one.
  showModal({
    key: 'GoogleDriveAuthNeeded',
    title: 'Authorize access to file',
    content: () =>
      m(Stack, [
        m(
          'p',
          "This is the first time you've accessed this app through the drive, please authorize access to the file.",
        ),
        m(Button, {
          label: 'Authorize File Access',
          intent: Intent.Primary,
          variant: ButtonVariant.Filled,
          onclick: async () => {
            let files: google.picker.DocumentObject[] | undefined;
            try {
              files = await client.requestFileAccess(accessToken, fileId);
            } catch (e) {
              showPickerFailedModal(e);
              return;
            }
            if (!files) return;
            const retryResult = await openGDriveTrace(app, client, fileId, {
              resourceKey,
              // The picker reports the name of the file just authorized.
              name: files[0]?.name,
            });
            closeModal('GoogleDriveAuthNeeded');
            if (!retryResult.ok) {
              showDownloadFailedModal(retryResult.error);
            }
          },
        }),
      ]),
  });
}

// Handles the Google Drive "Open with" deep link (?state=<json>).
async function handleOpenWithState(
  app: App,
  clientPromise: Promise<GoogleDriveClient | undefined>,
  state: string,
) {
  let raw: unknown;
  try {
    raw = JSON.parse(state);
  } catch {
    // Not a GDrive "Open with" payload; ignore.
    return;
  }

  const parsed = GDRIVE_OPEN_STATE_SCHEMA.safeParse(raw);
  if (!parsed.success) {
    return;
  }

  const fileId = parsed.data.ids?.[0];
  if (fileId === undefined || !isValidDriveId(fileId)) {
    return;
  }
  const resourceKey = parsed.data.resourceKeys?.[fileId];
  if (resourceKey !== undefined && !isValidDriveId(resourceKey)) {
    return;
  }

  const client = await clientPromise;
  if (client === undefined) {
    showUnavailableModal();
    return;
  }

  // Remove the 'state' query param now that we've consumed it. The router will
  // append ?local_cache_key=xxx to the hash once the trace finishes loading, so
  // that a reload reopens the trace from the browser's cache rather than from
  // Drive.
  const url = new URL(window.location.href);
  url.searchParams.delete('state');
  history.replaceState(null, '', url.toString());

  await openGDriveTraceWithAuth(app, client, fileId, resourceKey);
}

// Handles the ?openFileId= share link generated by the ShareForm.
async function handleOpenFileId(
  app: App,
  clientPromise: Promise<GoogleDriveClient | undefined>,
  fileId: string,
) {
  // Like a malformed ?state=, ignore an ID that cannot be a Drive file ID
  // rather than asking the user to sign in for it.
  if (!isValidDriveId(fileId)) return;

  const client = await clientPromise;
  if (client === undefined) {
    showUnavailableModal();
    return;
  }
  await openGDriveTraceWithAuth(app, client, fileId);
}

// Shown when a link asks for a Drive file but Google Drive support could not
// be initialized.
function showUnavailableModal() {
  showModal({
    key: 'GoogleDriveUnavailable',
    title: 'Google Drive unavailable',
    content: m(
      'p',
      'Opening traces from Google Drive is not available right now.',
    ),
    buttons: [{text: 'OK', primary: true}],
  });
}
