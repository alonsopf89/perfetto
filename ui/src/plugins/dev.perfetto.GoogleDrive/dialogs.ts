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
import type {AuthenticationResponse} from './gdrive/oauth_client';
import {alertModal} from './modal_prompt';

// The alerts shared by the flows that open a trace from Google Drive. Each
// one only tells the user what went wrong, and resolves once it is dismissed:
// what happens next is up to the flow.

// Tells the user that connecting to their Google account did not succeed.
export async function alertConnectFailed(
  auth: Exclude<AuthenticationResponse, {response: 'success'}>,
): Promise<void> {
  await alertModal({
    key: 'GoogleDriveConnectFailed',
    title: "Couldn't connect to Google Drive",
    content: m('p', describeAuthFailure(auth)),
  });
}

// Tells the user that the file picker could not be shown.
export async function alertPickerFailed(): Promise<void> {
  await alertModal({
    key: 'GoogleDrivePickerFailed',
    title: "Couldn't open the Google Drive file picker",
    content: m('p', 'The Google Drive file picker could not be opened.'),
  });
}

// Tells the user that a file could not be downloaded.
export async function alertDownloadFailed(): Promise<void> {
  await alertModal({
    key: 'GoogleDriveDownloadFailed',
    title: "Couldn't open file from Google Drive",
    content: m('p', 'The file could not be downloaded from Google Drive.'),
  });
}

// Explains, for the user, why connecting to their Google account did not
// succeed.
function describeAuthFailure(
  auth: Exclude<AuthenticationResponse, {response: 'success'}>,
): string {
  switch (auth.response) {
    case 'popup_blocked':
      return 'The Google authentication popup was blocked.';
    case 'popup_closed':
      return 'The Google window was closed before the connection was completed.';
    case 'error':
      return `Connecting to Google Drive failed: ${auth.message}`;
  }
}
