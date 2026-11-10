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

// Minimal ambient types for the Google APIs loaded dynamically at runtime
// (gapi, Google Picker, Drive API v3, Drive Share dialog, and Google Identity
// Services). Keeping these local avoids pulling in third-party @types packages
// (e.g. @types/gapi.client.drive-v3 and its transitive dependencies).

declare global {
  namespace gapi {
    function load(
      apiName: string,
      callbackOrConfig:
        | (() => void)
        | {
            callback: () => void;
            onerror?: () => void;
            timeout?: number;
            ontimeout?: () => void;
          },
    ): void;

    namespace drive {
      namespace share {
        class ShareClient {
          setOAuthToken(token: string): void;
          setItemIds(ids: string[]): void;
          showSettingsDialog(): void;
        }
      }
    }
  }

  namespace google.picker {
    interface DocumentObject {
      readonly id: string;
      readonly name?: string;
    }

    interface ResponseObject {
      readonly action: string;
      readonly docs?: DocumentObject[];
    }

    const Action: {
      readonly PICKED: string;
      readonly CANCEL: string;
      readonly ERROR: string;
    };

    const ViewId: {
      readonly DOCS: string;
      readonly FOLDERS: string;
    };

    const DocsViewMode: {
      readonly LIST: string;
    };

    class DocsView {
      constructor(viewId?: string);
      setMode(mode: string): this;
      setFileIds(fileIds: string): this;
      setIncludeFolders(include: boolean): this;
      setSelectFolderEnabled(enabled: boolean): this;
      setMimeTypes(mimeTypes: string): this;
    }

    interface Picker {
      setVisible(visible: boolean): void;
    }

    class PickerBuilder {
      setAppId(appId: string): this;
      setOAuthToken(token: string): this;
      setDeveloperKey(key: string): this;
      setOrigin(origin: string): this;
      addView(view: DocsView): this;
      setTitle(title: string): this;
      setCallback(callback: (data: ResponseObject) => void): this;
      build(): Picker;
    }
  }

  // The GSI OAuth2 token client returned by google.accounts.oauth2
  // .initTokenClient().
  interface GDriveTokenClient {
    requestAccessToken(options?: {prompt?: string}): void;
  }

  interface GDriveTokenResponse {
    readonly error?: string;
    readonly access_token?: string;
    readonly expires_in?: string;
    readonly token_type?: string;
    readonly scope?: string;
  }

  interface GDriveTokenClientError {
    readonly type?: string;
  }

  // The GSI scripts attach everything to window.google. We type the oauth2
  // token client here via a Window augmentation.
  interface Window {
    google?: {
      accounts?: {
        oauth2?: {
          initTokenClient(params: {
            client_id: string;
            scope: string;
            callback?: (response: GDriveTokenResponse) => void;
            error_callback?: (error: GDriveTokenClientError) => void;
          }): GDriveTokenClient;
        };
      };
    };
  }
}

// We can only augment the global scope from an external module.
export {};
