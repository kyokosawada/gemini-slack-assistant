import { google } from "googleapis";
import type { GmailApi } from "../tools/gmail";
import type { GoogleOAuthClient } from "./auth";

/**
 * Adapt the real googleapis Gmail client to the narrow {@link GmailApi} the
 * tools depend on. Keeping this adapter thin means the tools stay testable
 * against a fake of the same shape — this is the one spot that touches the SDK.
 */
export function createGmailApi(auth: GoogleOAuthClient): GmailApi {
  const gmail = google.gmail({ version: "v1", auth });
  return {
    users: {
      messages: {
        list: (params) => gmail.users.messages.list(params),
        get: (params) => gmail.users.messages.get(params),
      },
    },
  };
}
