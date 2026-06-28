import { readFileSync } from "node:fs";
import { google } from "googleapis";

/**
 * The OAuth client type, pinned to `google.auth.OAuth2`'s own instance type.
 * googleapis bundles its own copy of google-auth-library, so we derive the type
 * from the constructor we actually use rather than importing it separately —
 * otherwise the two copies' types collide.
 */
export type GoogleOAuthClient = InstanceType<typeof google.auth.OAuth2>;

/**
 * Google OAuth for the Gmail read tools. Read-only and nothing more — sending
 * email reuses bot #1's SMTP path, so this bot never holds a send/write scope.
 *
 * The flow uses two gitignored files in the project root:
 *   - `credentials.json` — the OAuth client downloaded from Google Cloud.
 *   - `token.json`       — the cached user token, minted by `bun run authorize`.
 *
 * Note: in Google's "Testing" consent mode the refresh token expires after
 * ~7 days, so re-run `bun run authorize` before a demo.
 */
export const GMAIL_READONLY_SCOPES = ["https://www.googleapis.com/auth/gmail.readonly"];

interface OAuthClientConfig {
  client_id: string;
  client_secret: string;
  redirect_uris: string[];
}

interface CredentialsFile {
  installed?: OAuthClientConfig;
  web?: OAuthClientConfig;
}

/** Build an OAuth client from `credentials.json` (no user token attached yet). */
export function createOAuthClient(credentialsPath = "credentials.json"): GoogleOAuthClient {
  let parsed: CredentialsFile;
  try {
    parsed = JSON.parse(readFileSync(credentialsPath, "utf8")) as CredentialsFile;
  } catch {
    throw new Error(
      `Could not read ${credentialsPath}. Download the OAuth client from Google Cloud and save it there.`,
    );
  }
  const config = parsed.installed ?? parsed.web;
  if (!config) {
    throw new Error(`${credentialsPath} is missing an "installed" or "web" OAuth client config.`);
  }
  return new google.auth.OAuth2(config.client_id, config.client_secret, config.redirect_uris[0]);
}

/**
 * Build an OAuth client with the cached user token attached, ready to authorize
 * Gmail API calls. Throws a clear, actionable error if the token is missing.
 */
export function loadAuthorizedClient(
  credentialsPath = "credentials.json",
  tokenPath = "token.json",
): GoogleOAuthClient {
  const client = createOAuthClient(credentialsPath);
  let token: unknown;
  try {
    token = JSON.parse(readFileSync(tokenPath, "utf8"));
  } catch {
    throw new Error(`No ${tokenPath} found — run "bun run authorize" to grant Gmail access first.`);
  }
  client.setCredentials(token as Record<string, unknown>);
  return client;
}
