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

import {loadScript} from '../../../base/dom_utils';
import {getErrorMessage} from '../../../base/errors';

// The Google Identity Services script, loaded once by
// GoogleOAuthClient.create().
const GSI_CLIENT_URL = 'https://accounts.google.com/gsi/client';

// How long to wait for that script before giving up. Without this a stalled
// request would never settle.
const LOAD_TIMEOUT_MS = 30000;

// How an attempt to get an access token ended.
export type AuthenticationResponse =
  | {
      // The user is connected.
      readonly response: 'success';
      readonly accessToken: string;
    }
  | {
      // The browser would not open Google's popup, which it only allows from a
      // user gesture. Trying again from a click should work.
      readonly response: 'popup_blocked';
    }
  | {
      // The user closed Google's popup without finishing.
      readonly response: 'popup_closed';
    }
  | {
      // Anything else: Google refused or reported an error. `message` says
      // what, and is suitable for showing to the user.
      readonly response: 'error';
      readonly message: string;
    };

// Obtains OAuth access tokens for the user's Google account, through Google
// Identity Services, and holds the current one in memory. It knows nothing
// about what the token is used for.
export class GoogleOAuthClient {
  private pendingToken: Promise<AuthenticationResponse> | undefined;
  private token: string | undefined;
  private tokenExpiresAtMs = 0;

  private constructor(
    private readonly clientId: string,
    private readonly scope: string,
  ) {}

  // Loads Google Identity Services and returns a ready-to-use client. Rejects
  // if it cannot be loaded.
  //
  // `scope` is a space separated list of the OAuth scopes to ask for.
  //
  // Nothing here opens a popup or needs a user gesture; only authenticate()
  // does.
  static async create(args: {
    readonly clientId: string;
    readonly scope: string;
  }): Promise<GoogleOAuthClient> {
    await loadScript(GSI_CLIENT_URL, LOAD_TIMEOUT_MS);
    if (window.google?.accounts?.oauth2 === undefined) {
      throw new Error('Google Identity Services is not available');
    }
    return new GoogleOAuthClient(args.clientId, args.scope);
  }

  // Returns an access token, asking the user to connect their Google account
  // if there is no valid one. That opens a Google popup, which browsers only
  // allow from a user gesture, so nothing is awaited here before the popup is
  // requested.
  //
  // This never rejects: every way it can end, including failure, is one of the
  // AuthenticationResponse cases.
  authenticate(): Promise<AuthenticationResponse> {
    if (this.token !== undefined && Date.now() < this.tokenExpiresAtMs) {
      return Promise.resolve({
        response: 'success',
        accessToken: this.token,
      });
    }

    // Share a single request between concurrent callers, and forget it once it
    // settles so that a later call can try again.
    if (this.pendingToken === undefined) {
      this.pendingToken = this.requestToken().finally(() => {
        this.pendingToken = undefined;
      });
    }
    return this.pendingToken;
  }

  // Asks Google for a new token. Like authenticate(), this never rejects.
  private requestToken(): Promise<AuthenticationResponse> {
    return new Promise<AuthenticationResponse>((resolve) => {
      const fail = (message: string) => resolve({response: 'error', message});

      // The google.accounts.oauth2 token client is typed via the Window
      // augmentation in ../types/google_identity.d.ts.
      const oauth2 = window.google?.accounts?.oauth2;
      if (oauth2 === undefined) {
        fail('Google Identity Services is not available');
        return;
      }

      // Google's library is not expected to throw, but if it did this promise
      // would reject, so report that as an error like any other.
      try {
        const tokenClient: GDriveTokenClient = oauth2.initTokenClient({
          client_id: this.clientId,
          scope: this.scope,
          callback: (tokenResponse: GDriveTokenResponse) => {
            const error = tokenResponse.error;
            if (typeof error === 'string' && error !== '') {
              fail(error);
              return;
            }
            const accessToken = tokenResponse.access_token;
            if (typeof accessToken !== 'string') {
              fail('No access token returned');
              return;
            }
            const parsedExpires = Number(tokenResponse.expires_in);
            const expiresInSec = Number.isFinite(parsedExpires)
              ? parsedExpires
              : 3600;
            this.token = accessToken;
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
              fail(`Google reported an error: ${error.type}`);
            }
          },
        });
        tokenClient.requestAccessToken({prompt: ''});
      } catch (e) {
        fail(getErrorMessage(e));
      }
    });
  }
}
