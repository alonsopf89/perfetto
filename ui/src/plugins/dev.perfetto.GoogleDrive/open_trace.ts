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
import type {GDriveClient, OpenFileResult} from './gdrive/gdrive_client';
import type {GoogleOAuthClient} from './gdrive/oauth_client';

// Helpers shared by the flows that open a trace from Google Drive.

// The two clients those flows work with, once Google Drive support has been
// initialized: `oauth` connects to the user's Google account, and `drive`
// talks to Drive on its behalf.
export interface GDriveClients {
  readonly oauth: GoogleOAuthClient;
  readonly drive: GDriveClient;
}

// What downloadGDriveFile() resolves with.
export interface GDriveDownload {
  // The file's contents, or why they could not be downloaded.
  readonly result: OpenFileResult;
  // The file's name, if it is known.
  readonly name: string | undefined;
}

// Downloads a file from Google Drive, along with its name. This only fetches:
// it shows nothing to the user and does not open the trace.
//
// `opts.knownName` is the file's name if the caller already has it (the picker
// reports it). Otherwise it is looked up from Drive alongside the download, as
// the "Open with" deep link only gives us the file ID. This never rejects:
// failure is reported through `result`, and a failed name lookup just leaves
// `name` undefined.
export async function downloadGDriveFile(
  client: GDriveClient,
  oauthToken: string,
  fileId: string,
  opts?: {resourceKey?: string; knownName?: string},
): Promise<GDriveDownload> {
  const knownName = opts?.knownName;
  const namePromise: Promise<string | undefined> =
    knownName !== undefined
      ? Promise.resolve(knownName)
      : client
          .getMeta(oauthToken, fileId, opts?.resourceKey)
          .then((meta) => meta?.name);
  const filePromise = client.openFile(oauthToken, fileId, opts?.resourceKey);
  const [name, result] = await Promise.all([namePromise, filePromise]);
  return {result, name};
}

// Opens a file downloaded from Google Drive as a trace.
export function openGDriveBufferAsTrace(
  app: App,
  buffer: ArrayBuffer,
  name: string | undefined,
): void {
  // Fall back to a generic name if Drive could not tell us the real one.
  const traceName = name ?? 'Google Drive Trace';
  app.openTraceFromBuffer({
    buffer,
    title: traceName,
    fileName: traceName,
    // ACL-protected Drive traces must not be re-uploaded to the public
    // perfetto-ui-data GCS bucket via permalinks or crash reports.
    shareable: false,
  });
}
