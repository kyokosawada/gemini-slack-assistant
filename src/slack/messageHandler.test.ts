import { describe, it, expect } from "bun:test";
import {
  handleIncomingMessage,
  renderReply,
  type Responder,
  type SlackMessage,
} from "./messageHandler";
import type { AgentReply } from "../agent/agentLoop";

function collectSay() {
  const said: SlackMessage[] = [];
  const say = async (m: SlackMessage) => void said.push(m);
  return { said, say };
}

describe("renderReply", () => {
  it("renders a text reply as a plain message", () => {
    expect(renderReply({ kind: "text", text: "hello" })).toEqual({ text: "hello" });
  });

  it("renders a confirm reply as a Block Kit preview carrying the key", () => {
    const reply: AgentReply = {
      kind: "confirm",
      key: "pending-1",
      draft: { to: "jane@acme.com", subject: "Hi", body: "hey" },
    };

    const msg = renderReply(reply);

    expect(msg.blocks).toBeDefined();
    const json = JSON.stringify(msg.blocks);
    expect(json).toContain("jane@acme.com");
    expect(json).toContain("pending-1");
    expect(msg.text).toContain("jane@acme.com"); // fallback text for notifications
  });
});

describe("handleIncomingMessage", () => {
  it("posts the rendered text reply", async () => {
    const { said, say } = collectSay();
    const respond: Responder = async () => ({ kind: "text", text: "LOOP reply" });

    await handleIncomingMessage({ text: "hello" }, say, respond);

    expect(said).toEqual([{ text: "LOOP reply" }]);
  });

  it("passes normalized text (leading mention stripped) to the responder", async () => {
    const { say } = collectSay();
    const seen: string[] = [];
    const respond: Responder = async (t) => {
      seen.push(t);
      return { kind: "text", text: "ok" };
    };

    await handleIncomingMessage({ text: "<@U07ABC123> book a meeting" }, say, respond);

    expect(seen).toEqual(["book a meeting"]);
  });

  it("posts a Block Kit preview for a confirm reply", async () => {
    const { said, say } = collectSay();
    const respond: Responder = async () => ({
      kind: "confirm",
      key: "pending-1",
      draft: { to: "jane@acme.com", subject: "Hi", body: "hey" },
    });

    await handleIncomingMessage({ text: "email jane" }, say, respond);

    expect(said).toHaveLength(1);
    expect(said[0]!.blocks).toBeDefined();
    expect(JSON.stringify(said[0]!.blocks)).toContain("pending-1");
  });

  it("nudges on an empty body without calling the responder", async () => {
    const { said, say } = collectSay();
    let called = false;
    const respond: Responder = async () => {
      called = true;
      return { kind: "text", text: "x" };
    };

    await handleIncomingMessage({ text: "<@U07ABC123>" }, say, respond);

    expect(called).toBe(false);
    expect(said[0]!.text).toContain("what can I help");
  });
});
