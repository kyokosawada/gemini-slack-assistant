import { describe, it, expect } from "bun:test";
import { toContent, toModelReply } from "./gemini";
import type { Message } from "./provider";

describe("toContent (conversation → Gemini contents)", () => {
  it("maps a user turn to a user text part", () => {
    expect(toContent({ role: "user", text: "hi" })).toEqual({
      role: "user",
      parts: [{ text: "hi" }],
    });
  });

  it("maps an assistant turn to a model text part", () => {
    expect(toContent({ role: "assistant", text: "hello" })).toEqual({
      role: "model",
      parts: [{ text: "hello" }],
    });
  });

  it("maps a tool_call to a model functionCall part", () => {
    const m: Message = { role: "tool_call", call: { name: "search_emails", args: { query: "x" } } };
    expect(toContent(m)).toEqual({
      role: "model",
      parts: [{ functionCall: { name: "search_emails", args: { query: "x" } } }],
    });
  });

  it("maps a tool_result to a user functionResponse part under the output key", () => {
    const m: Message = { role: "tool_result", name: "search_emails", result: [{ id: "m1" }] };
    expect(toContent(m)).toEqual({
      role: "user",
      parts: [{ functionResponse: { name: "search_emails", response: { output: [{ id: "m1" }] } } }],
    });
  });
});

describe("toModelReply (Gemini response → ModelReply)", () => {
  it("returns the model's text when there is no function call", () => {
    expect(toModelReply({ text: "the answer" })).toEqual({ kind: "text", text: "the answer" });
  });

  it("returns a tool_call when the model requests a function", () => {
    expect(toModelReply({ functionCalls: [{ name: "read_email", args: { id: "m1" } }] })).toEqual({
      kind: "tool_call",
      call: { name: "read_email", args: { id: "m1" } },
    });
  });

  it("prefers the function call over any accompanying text", () => {
    expect(
      toModelReply({ text: "", functionCalls: [{ name: "search_emails", args: {} }] }),
    ).toEqual({ kind: "tool_call", call: { name: "search_emails", args: {} } });
  });

  it("defaults a missing name/args to safe empties", () => {
    expect(toModelReply({ functionCalls: [{}] })).toEqual({
      kind: "tool_call",
      call: { name: "", args: {} },
    });
  });

  it("returns empty text when the model returns nothing usable", () => {
    expect(toModelReply({})).toEqual({ kind: "text", text: "" });
  });
});
