import type { Tool } from "./registry";

/**
 * The slice of the googleapis Gmail client this bot uses, narrowed to the two
 * read-only calls behind `search_emails` and `read_email`. The real client
 * (`google.gmail({ version: "v1", auth })`) satisfies this shape, and tests pass
 * a fake — so the tools are exercised against mocked Google responses without a
 * network or real credentials. Read-only: `gmail.readonly` scope, nothing else.
 */
export interface GmailApi {
  users: {
    messages: {
      list(params: {
        userId: string;
        q?: string;
        maxResults?: number;
      }): Promise<{ data: GmailListResponse }>;
      get(params: {
        userId: string;
        id: string;
        format?: string;
        metadataHeaders?: string[];
      }): Promise<{ data: GmailMessageResource }>;
    };
  };
}

export interface GmailListResponse {
  messages?: Array<{ id?: string | null; threadId?: string | null }> | null;
  resultSizeEstimate?: number | null;
}

export interface GmailHeader {
  name?: string | null;
  value?: string | null;
}

export interface GmailPayload {
  mimeType?: string | null;
  headers?: GmailHeader[] | null;
  body?: { data?: string | null } | null;
  parts?: GmailPayload[] | null;
}

export interface GmailMessageResource {
  id?: string | null;
  threadId?: string | null;
  snippet?: string | null;
  payload?: GmailPayload | null;
}

/** A match shaped for the model: enough to summarize and to call `read_email`. */
export interface EmailSummary {
  id: string;
  from: string;
  subject: string;
  date: string;
  snippet: string;
}

/** One message's full content, shaped for the model to read and summarize. */
export interface EmailContent {
  id: string;
  from: string;
  to: string;
  subject: string;
  date: string;
  body: string;
}

/** How many search hits to surface to the model in one turn. */
const MAX_SEARCH_RESULTS = 10;

/** Read a header value case-insensitively, defaulting to an empty string. */
function header(payload: GmailPayload | null | undefined, name: string): string {
  const match = payload?.headers?.find((h) => h.name?.toLowerCase() === name.toLowerCase());
  return match?.value ?? "";
}

/**
 * Extract the plain-text body from a Gmail payload. Gmail base64url-encodes body
 * data and nests it in `parts` for multipart messages, so we walk the tree and
 * return the first `text/plain` part — falling back to any decodable body.
 */
function plainTextBody(payload: GmailPayload | null | undefined): string {
  if (!payload) return "";
  const decode = (data?: string | null) =>
    data ? Buffer.from(data, "base64url").toString("utf8") : "";

  if (payload.mimeType === "text/plain" && payload.body?.data) return decode(payload.body.data);
  for (const part of payload.parts ?? []) {
    const text = plainTextBody(part);
    if (text) return text;
  }
  return decode(payload.body?.data);
}

/**
 * `search_emails(query)` — search the user's Gmail and return matching messages
 * shaped for the model. The query is Gmail's own search syntax (e.g.
 * `from:jane is:unread newer_than:1d`). No matches yields an empty list, which
 * the agent loop feeds back so the model can say nothing was found.
 */
export function searchEmailsTool(gmail: GmailApi): Tool {
  return {
    definition: {
      name: "search_emails",
      description:
        "Search the user's Gmail using Gmail search syntax (e.g. 'from:jane is:unread newer_than:1d') " +
        "and return matching messages. Pass a returned id to read_email for the full content.",
      parameters: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "A Gmail search query, using Gmail's standard search operators.",
          },
        },
        required: ["query"],
      },
    },

    async run(args) {
      const query = String(args.query ?? "");
      const { data } = await gmail.users.messages.list({
        userId: "me",
        q: query,
        maxResults: MAX_SEARCH_RESULTS,
      });

      const matches = data.messages ?? [];
      const summaries: EmailSummary[] = [];
      for (const { id } of matches) {
        if (!id) continue;
        const { data: msg } = await gmail.users.messages.get({
          userId: "me",
          id,
          format: "metadata",
          metadataHeaders: ["From", "Subject", "Date"],
        });
        summaries.push({
          id: msg.id ?? id,
          from: header(msg.payload, "From"),
          subject: header(msg.payload, "Subject"),
          date: header(msg.payload, "Date"),
          snippet: msg.snippet ?? "",
        });
      }
      return summaries;
    },
  };
}

/**
 * `read_email(id)` — fetch a single message in full and return its sender,
 * recipient, subject, date, and decoded plain-text body for the model to read
 * and summarize. The id comes from a prior `search_emails` result.
 */
export function readEmailTool(gmail: GmailApi): Tool {
  return {
    definition: {
      name: "read_email",
      description:
        "Read one email by its id (from a search_emails result) and return its sender, " +
        "recipient, subject, date, and full text body.",
      parameters: {
        type: "object",
        properties: {
          id: { type: "string", description: "The message id returned by search_emails." },
        },
        required: ["id"],
      },
    },

    async run(args) {
      const id = String(args.id ?? "");
      const { data: msg } = await gmail.users.messages.get({ userId: "me", id, format: "full" });
      const content: EmailContent = {
        id: msg.id ?? id,
        from: header(msg.payload, "From"),
        to: header(msg.payload, "To"),
        subject: header(msg.payload, "Subject"),
        date: header(msg.payload, "Date"),
        body: plainTextBody(msg.payload),
      };
      return content;
    },
  };
}
