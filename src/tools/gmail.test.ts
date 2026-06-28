import { describe, it, expect } from "bun:test";
import {
  searchEmailsTool,
  readEmailTool,
  type GmailApi,
  type GmailListResponse,
  type GmailMessageResource,
} from "./gmail";

/** Base64url-encode text the way the Gmail API delivers message bodies. */
function b64url(text: string): string {
  return Buffer.from(text, "utf8").toString("base64url");
}

/**
 * A fake standing in for the googleapis Gmail client, recording the params it
 * was called with and returning scripted responses (or throwing for errors).
 */
function fakeGmail(handlers: {
  list?: (params: { userId: string; q?: string; maxResults?: number }) => GmailListResponse;
  get?: (params: { userId: string; id: string }) => GmailMessageResource;
}): GmailApi & {
  listCalls: Array<{ userId: string; q?: string; maxResults?: number }>;
  getCalls: Array<{ userId: string; id: string; format?: string; metadataHeaders?: string[] }>;
} {
  const listCalls: any[] = [];
  const getCalls: any[] = [];
  return {
    listCalls,
    getCalls,
    users: {
      messages: {
        list: async (params) => {
          listCalls.push(params);
          return { data: handlers.list?.(params) ?? {} };
        },
        get: async (params) => {
          getCalls.push(params);
          return { data: handlers.get?.(params) ?? {} };
        },
      },
    },
  };
}

function messageWithHeaders(id: string, headers: Record<string, string>, snippet: string): GmailMessageResource {
  return {
    id,
    snippet,
    payload: { headers: Object.entries(headers).map(([name, value]) => ({ name, value })) },
  };
}

describe("searchEmailsTool", () => {
  it("queries Gmail and returns matches shaped for the model", async () => {
    const gmail = fakeGmail({
      list: () => ({ messages: [{ id: "m1" }, { id: "m2" }] }),
      get: ({ id }) =>
        messageWithHeaders(
          id,
          { From: `${id}@example.com`, Subject: `Subject ${id}`, Date: "Mon, 01 Jun 2026 09:00:00 -0700" },
          `snippet ${id}`,
        ),
    });

    const tool = searchEmailsTool(gmail);
    const result = await tool.run({ query: "from:jane is:unread" });

    // request shaping: a scoped list query for the signed-in user
    expect(gmail.listCalls).toEqual([{ userId: "me", q: "from:jane is:unread", maxResults: 10 }]);
    // result parsing: each match carries id + the headers the model needs to summarize
    expect(result).toEqual([
      { id: "m1", from: "m1@example.com", subject: "Subject m1", date: "Mon, 01 Jun 2026 09:00:00 -0700", snippet: "snippet m1" },
      { id: "m2", from: "m2@example.com", subject: "Subject m2", date: "Mon, 01 Jun 2026 09:00:00 -0700", snippet: "snippet m2" },
    ]);
  });

  it("returns an empty list when nothing matches, without fetching messages", async () => {
    const gmail = fakeGmail({ list: () => ({}) }); // Gmail omits `messages` when there are no hits

    const tool = searchEmailsTool(gmail);
    const result = await tool.run({ query: "from:nobody" });

    expect(result).toEqual([]);
    expect(gmail.getCalls).toHaveLength(0);
  });

  it("propagates a Gmail API error (e.g. expired auth) instead of swallowing it", async () => {
    const gmail = fakeGmail({
      list: () => {
        throw new Error("invalid_grant: token expired");
      },
    });

    const tool = searchEmailsTool(gmail);

    expect(tool.run({ query: "anything" })).rejects.toThrow("invalid_grant");
  });
});

describe("readEmailTool", () => {
  it("fetches one message in full and returns its content with a decoded text body", async () => {
    const gmail = fakeGmail({
      get: ({ id }) => ({
        id,
        snippet: "preview…",
        payload: {
          mimeType: "multipart/alternative",
          headers: [
            { name: "From", value: "Jane <jane@example.com>" },
            { name: "To", value: "me@example.com" },
            { name: "Subject", value: "Intro call" },
            { name: "Date", value: "Tue, 02 Jun 2026 10:00:00 -0700" },
          ],
          parts: [
            { mimeType: "text/plain", body: { data: b64url("Hi — can we meet Thursday?") } },
            { mimeType: "text/html", body: { data: b64url("<p>Hi — can we meet Thursday?</p>") } },
          ],
        },
      }),
    });

    const tool = readEmailTool(gmail);
    const result = await tool.run({ id: "m1" });

    expect(gmail.getCalls).toEqual([{ userId: "me", id: "m1", format: "full" }]);
    expect(result).toEqual({
      id: "m1",
      from: "Jane <jane@example.com>",
      to: "me@example.com",
      subject: "Intro call",
      date: "Tue, 02 Jun 2026 10:00:00 -0700",
      body: "Hi — can we meet Thursday?",
    });
  });

  it("propagates a Gmail API error when reading a message", async () => {
    const gmail = fakeGmail({
      get: () => {
        throw new Error("invalid_grant: token expired");
      },
    });

    const tool = readEmailTool(gmail);

    expect(tool.run({ id: "m1" })).rejects.toThrow("invalid_grant");
  });
});
