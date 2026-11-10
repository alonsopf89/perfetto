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

import type {App} from '../../public/app';
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

// Opens a file the user chooses from Google Drive, when they click the sidebar
// button. This is the whole flow, start to finish: each step either moves on
// to the next or tells the user why it could not.
export async function openFileFromSidebar(app: App, clients: GDriveClients) {
  const {oauth, drive} = clients;

  // Authenticate with the oauth client and obtain an access token. This runs
  // from the sidebar button's click, and nothing is awaited before this call,
  // so the browser allows the Google popup.
  const auth = await oauth.authenticate();
  if (auth.response !== 'success') {
    console.error('Failed to authenticate with Google OAuth', auth);
    await alertConnectFailed(auth);
    return;
  }
  const oauthToken = auth.accessToken;

  // Let the user choose a file. Picking a file is also what authorizes the
  // app to read it.
  let picked: google.picker.DocumentObject[] | undefined;
  try {
    picked = await drive.pickFile(oauthToken);
  } catch (e) {
    console.error('Failed to open the Google Drive file picker', e);
    await alertPickerFailed();
    return;
  }
  // The user cancelled the picker, or picked nothing.
  const file = picked?.[0];
  if (file === undefined) return;

  // Download the file. The picker reports its name, which saves looking it
  // up.
  const download = await downloadGDriveFile(drive, oauthToken, file.id, {
    knownName: file.name,
  });
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
