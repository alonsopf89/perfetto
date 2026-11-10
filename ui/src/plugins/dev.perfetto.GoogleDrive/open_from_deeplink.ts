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
import type {App} from '../../public/app';
import {parseGDriveStateParam} from './gdrive/gdrive_client';
import {alertModal, promptModal} from './modal_prompt';
import {
  alertConnectFailed,
  alertDownloadFailed,
  alertPickerFailed,
} from './dialogs';
import {
  downloadGDriveFile,
  openGDriveBufferAsTrace,
  type GDriveClients,
} from './open_trace';

// Opens the file named by Google Drive's "Open with" deep link, given the value
// of its `state` parameter. This is the whole flow, start to finish: each step
// either moves on to the next or tells the user why it could not.
export async function openFileFromDeeplink(
  app: App,
  clientsPromise: Promise<GDriveClients | undefined>,
  state: string,
) {
  // Wait for the clients to load or timeout - alert user on timeout.
  const clients = await clientsPromise;
  if (clients === undefined) {
    await alertModal({
      key: 'GoogleDriveUnavailable',
      title: 'Google Drive unavailable',
      content: m(
        'p',
        'Opening traces from Google Drive is not available right now.',
      ),
    });
    return;
  }
  const {oauth, drive} = clients;

  // Parse the incoming state parameter from the "Open with" deep link.
  const parsed = parseGDriveStateParam(state);
  if (!parsed.ok) {
    // Failed to parse state parameter; ignore.
    return;
  }
  const {fileId, resourceKey} = parsed.value;

  // Autenticate with the oauth client and obtain an access token. Since this
  // workflow is unattended we might need to open a popup and have the user
  // interact with the button before the popup will appear.
  let auth = await oauth.authenticate();
  if (auth.response === 'popup_blocked') {
    const choice = await promptModal({
      key: 'GoogleDriveConnect',
      title: 'Connect to Google Drive',
      content: [
        m(
          'p',
          'Perfetto needs to connect to your Google account to open this trace.',
        ),
        m(
          'p',
          'To skip this step in future, allow pop-ups for this site in your browser settings.',
        ),
      ],
      buttons: [
        {text: 'Connect', value: 'retry', primary: true},
        {text: 'Cancel', value: 'cancel'},
      ],
    });
    if (choice !== 'retry') return;

    // Try again. This runs shortly after the click, not inside it: see
    // promptModal() for why the popup is still allowed.
    auth = await oauth.authenticate();
  }

  if (auth.response !== 'success') {
    console.error('Failed to authenticate with Google OAuth', auth);
    await alertConnectFailed(auth);
    return;
  }
  const oauthToken = auth.accessToken;

  // We are committed to opening this file now, so consume the 'state' query
  // param. The router will append ?local_cache_key=xxx to the hash once the
  // trace finishes loading, so that a reload reopens the trace from the
  // browser's cache rather than from Drive.
  removeStateParamFromUrl();

  // Attempt to download the file.
  let download = await downloadGDriveFile(drive, oauthToken, fileId, {
    resourceKey,
  });

  // If access is blocked, attempt to open it via the picker instead. The app
  // can only read files the user has opened or picked with it, so picking the
  // file is what authorizes it.
  if (!download.result.ok && download.result.accessDenied) {
    const choice = await promptModal({
      key: 'GoogleDriveAuthNeeded',
      title: 'Authorize access to file',
      content: m(
        'p',
        "This is the first time you've accessed this app through the drive, please authorize access to the file.",
      ),
      buttons: [
        {text: 'Authorize File Access', value: 'authorize', primary: true},
        {text: 'Cancel', value: 'cancel'},
      ],
    });
    if (choice !== 'authorize') return;

    let picked: google.picker.DocumentObject[] | undefined;
    try {
      picked = await drive.requestFileAccess(oauthToken, fileId);
    } catch (e) {
      console.error('Failed to open the Google Drive file picker', e);
      await alertPickerFailed();
      return;
    }
    // The user cancelled the picker.
    if (picked === undefined) return;

    // Try the download again. The picker reports the name of the file just
    // authorized, which saves looking it up.
    download = await downloadGDriveFile(drive, oauthToken, fileId, {
      resourceKey,
      knownName: picked[0]?.name,
    });
  }

  if (!download.result.ok) {
    console.error(
      'Failed to download file from Google Drive',
      download.result.error,
    );
    await alertDownloadFailed();
    return;
  }

  openGDriveBufferAsTrace(app, download.result.value, download.name);
}

// Removes the "Open with" deep link's 'state' query param from the address
// bar.
function removeStateParamFromUrl(): void {
  const url = new URL(window.location.href);
  url.searchParams.delete('state');
  history.replaceState(null, '', url.toString());
}
