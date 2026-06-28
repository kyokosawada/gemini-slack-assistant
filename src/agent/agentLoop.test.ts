import { describe, it, expect } from "bun:test";
import { createAgentLoop, type AgentReply } from "./agentLoop";
import type { Message, ModelProvider, ModelReply, ToolDefinition } from "../model/provider";
import { createConfirmationManager } from "../confirmation/confirmationManager";
import type { EmailDraft, EmailSender } from "../email/sender";

/** A provider scripted with canned replies — no network. */
function scriptedProvider(
  replies: ModelReply[],
): ModelProvider & { calls: { conversation: Message[]; tools: ToolDefinition[] }[] } {
  const calls: { conversation: Message[]; tools: ToolDefinition[] }[] = [];
  let i = 0;
  return {
    name: "scripted",
    calls,
    generate: async (conversation, tools) => {
      calls.push({ conversation, tools });
      return replies[Math.min(i++, replies.length - 1)]!;
    },
  };
}

/** An email sender that records what it was asked to send — never sends. */
function recordingSender(): EmailSender & { sent: EmailDraft[] } {
  const sent: EmailDraft[] = [];
  return { sent, send: async (draft) => void sent.push(draft) };
}

function makeAgent(provider: ModelProvider) {
  const sender = recordingSender();
  const confirmation = createConfirmationManager();
  const agent = createAgentLoop(provider, confirmation, sender);
  return { agent, sender, confirmation };
}

/** Build loosely-typed tool args (as the model would send) from a draft. */
function argsOf(d: EmailDraft): Record<string, unknown> {
  return { to: d.to, subject: d.subject, body: d.body };
}

/** Assert a reply is text and return it, for narrowing. */
function textOf(reply: AgentReply): string {
  expect(reply.kind).toBe("text");
  if (reply.kind !== "text") throw new Error("expected a text reply");
  return reply.text;
}

describe("createAgentLoop", () => {
  it("sends the user message to the provider and returns its text reply", async () => {
    const provider = scriptedProvider([{ kind: "text", text: "hi back" }]);
    const { agent } = makeAgent(provider);

    const reply = await agent.respond("thread-1", "hello");

    expect(reply).toEqual({ kind: "text", text: "hi back" });
    expect(provider.calls[0]!.conversation.at(-1)).toEqual({ role: "user", text: "hello" });
  });

  it("persists conversation context per thread across messages", async () => {
    const provider = scriptedProvider([
      { kind: "text", text: "first reply" },
      { kind: "text", text: "second reply" },
    ]);
    const { agent } = makeAgent(provider);

    await agent.respond("t1", "first message");
    await agent.respond("t1", "second message");

    expect(provider.calls[1]!.conversation).toEqual([
      { role: "user", text: "first message" },
      { role: "assistant", text: "first reply" },
      { role: "user", text: "second message" },
    ]);
  });

  it("keeps separate threads isolated", async () => {
    const provider = scriptedProvider([{ kind: "text", text: "ok" }]);
    const { agent } = makeAgent(provider);

    await agent.respond("t1", "hello from one");
    await agent.respond("t2", "hello from two");

    expect(provider.calls[1]!.conversation).toEqual([{ role: "user", text: "hello from two" }]);
  });

  it("returns a clear error message when the provider fails", async () => {
    const provider: ModelProvider = {
      name: "boom",
      generate: async () => {
        throw new Error("network exploded");
      },
    };
    const { agent } = makeAgent(provider);

    const reply = await agent.respond("t1", "hello");

    expect(textOf(reply)).toContain("couldn't reach the model");
  });

  it("surfaces a clear message when the model requests an unsupported tool", async () => {
    const provider = scriptedProvider([
      { kind: "tool_call", call: { name: "search_emails", args: { query: "x" } } },
    ]);
    const { agent } = makeAgent(provider);

    const reply = await agent.respond("t1", "find my emails");

    expect(textOf(reply)).toContain("can't use");
  });

  it("advertises the send_email tool to the model", async () => {
    const provider = scriptedProvider([{ kind: "text", text: "ok" }]);
    const { agent } = makeAgent(provider);

    await agent.respond("t1", "hi");

    const sendTool = provider.calls[0]!.tools.find((t) => t.name === "send_email");
    expect(sendTool).toBeDefined();
    expect(sendTool!.parameters).toMatchObject({
      properties: { to: {}, subject: {}, body: {} },
      required: ["to", "subject", "body"],
    });
  });

  it("gates a send_email request: parks a confirmation and sends nothing yet", async () => {
    const draft: EmailDraft = { to: "jane@acme.com", subject: "Hi", body: "hey" };
    const provider = scriptedProvider([
      { kind: "tool_call", call: { name: "send_email", args: argsOf(draft) } },
    ]);
    const { agent, sender, confirmation } = makeAgent(provider);

    const reply = await agent.respond("t1", "email jane");

    expect(reply.kind).toBe("confirm");
    if (reply.kind !== "confirm") throw new Error("expected a confirm reply");
    expect(reply.draft).toEqual(draft);
    expect(typeof reply.key).toBe("string");
    expect(confirmation.pendingCount).toBe(1);
    expect(sender.sent).toEqual([]); // nothing sent until the Send button is clicked

    // Only the confirm event (the button) triggers the actual send.
    await confirmation.confirm(reply.key);
    expect(sender.sent).toEqual([draft]);
  });

  it("edits a live draft in place when the model re-proposes on the same thread", async () => {
    const first: EmailDraft = { to: "jane@acme.com", subject: "Hi", body: "the long version" };
    const edited: EmailDraft = { to: "jane@acme.com", subject: "Hi", body: "short" };
    const provider = scriptedProvider([
      { kind: "tool_call", call: { name: "send_email", args: argsOf(first) } },
      { kind: "tool_call", call: { name: "send_email", args: argsOf(edited) } },
    ]);
    const { agent, sender, confirmation } = makeAgent(provider);

    const r1 = await agent.respond("t1", "email jane the long pitch");
    const r2 = await agent.respond("t1", "make it shorter");

    if (r1.kind !== "confirm" || r2.kind !== "confirm") throw new Error("expected confirm replies");
    expect(r2.key).toBe(r1.key); // same preview message, edited in place
    expect(r2.draft).toEqual(edited);
    expect(confirmation.pendingCount).toBe(1); // not stacked into a second pending send

    await confirmation.confirm(r2.key);
    expect(sender.sent).toEqual([edited]); // only the edited draft goes out
  });

  it("does not poison thread history when a turn fails", async () => {
    let shouldFail = true;
    const seen: Message[][] = [];
    const provider: ModelProvider = {
      name: "flaky",
      generate: async (conversation) => {
        seen.push(conversation);
        if (shouldFail) {
          shouldFail = false;
          throw new Error("boom");
        }
        return { kind: "text", text: "recovered" };
      },
    };
    const { agent } = makeAgent(provider);

    await agent.respond("t1", "hello"); // fails
    await agent.respond("t1", "hello again"); // succeeds

    expect(seen[1]).toEqual([{ role: "user", text: "hello again" }]);
  });
});
