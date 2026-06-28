import { describe, it, expect } from "bun:test";
import { createAgentLoop, SEND_EMAIL_TOOL, type AgentReply } from "./agentLoop";
import type {
  Message,
  ModelProvider,
  ModelReply,
  ToolCall,
  ToolDefinition,
} from "../model/provider";
import type { ToolOutcome, ToolRegistry } from "../tools/registry";
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

/** A registry scripted with canned outcomes, recording the calls it received. */
function recordingRegistry(
  outcomes: ToolOutcome[],
  definitions: ToolDefinition[] = [],
): ToolRegistry & { calls: ToolCall[] } {
  const calls: ToolCall[] = [];
  let i = 0;
  return {
    definitions,
    calls,
    execute: async (call) => {
      calls.push(call);
      return outcomes[Math.min(i++, outcomes.length - 1)]!;
    },
  };
}

/** A registry that advertises no read tools — used by text-only/send tests. */
const noTools = (): ToolRegistry => ({
  definitions: [],
  execute: async () => ({ ok: false, error: "no tools" }),
});

/** An email sender that records what it was asked to send — never sends. */
function recordingSender(): EmailSender & { sent: EmailDraft[] } {
  const sent: EmailDraft[] = [];
  return { sent, send: async (draft) => void sent.push(draft) };
}

function makeAgent(provider: ModelProvider, registry: ToolRegistry = noTools()) {
  const sender = recordingSender();
  const confirmation = createConfirmationManager();
  const agent = createAgentLoop(provider, registry, confirmation, sender);
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

  it("executes a requested tool, feeds the result back, and returns the model's summary", async () => {
    const searchDef: ToolDefinition = {
      name: "search_emails",
      description: "Search the user's email",
      parameters: { type: "object", properties: { query: { type: "string" } } },
    };
    const provider = scriptedProvider([
      { kind: "tool_call", call: { name: "search_emails", args: { query: "leads today" } } },
      { kind: "text", text: "You have 2 new leads." },
    ]);
    const registry = recordingRegistry([{ ok: true, value: [{ id: "m1", subject: "Lead A" }] }], [searchDef]);

    const { agent } = makeAgent(provider, registry);
    const reply = await agent.respond("t1", "what leads came in today?");

    expect(reply).toEqual({ kind: "text", text: "You have 2 new leads." });
    // the tool the model asked for was actually executed
    expect(registry.calls).toEqual([{ name: "search_emails", args: { query: "leads today" } }]);
    // read-tool definitions are advertised to the model, alongside the gated send tool
    expect(provider.calls[0]!.tools).toEqual([searchDef, SEND_EMAIL_TOOL]);
    // the result was fed back: the second generate sees the call + its result
    expect(provider.calls[1]!.conversation).toEqual([
      { role: "user", text: "what leads came in today?" },
      { role: "tool_call", call: { name: "search_emails", args: { query: "leads today" } } },
      { role: "tool_result", name: "search_emails", result: [{ id: "m1", subject: "Lead A" }] },
    ]);
  });

  it("surfaces the tool's failure cause and does not poison later turns", async () => {
    const provider = scriptedProvider([
      { kind: "tool_call", call: { name: "search_emails", args: { query: "x" } } }, // turn 1 → tool fails
      { kind: "text", text: "hello there" }, // turn 2 → normal text
    ]);
    const registry = recordingRegistry([{ ok: false, error: "expired auth" }]);
    const { agent } = makeAgent(provider, registry);

    const first = await agent.respond("t1", "find emails");
    expect(textOf(first)).toContain("tool failed");
    expect(textOf(first)).toContain("expired auth"); // the real cause reaches the user (story 23)

    await agent.respond("t1", "hi");
    // the failed turn left nothing behind: the next turn starts from a clean thread
    expect(provider.calls.at(-1)!.conversation).toEqual([{ role: "user", text: "hi" }]);
  });

  it("returns a clear error when the model requests a tool the registry can't run", async () => {
    const provider = scriptedProvider([
      { kind: "tool_call", call: { name: "search_emails", args: { query: "x" } } },
    ]);
    const { agent } = makeAgent(provider);

    const reply = await agent.respond("t1", "find my emails");

    expect(textOf(reply)).toContain("tool failed");
    expect(provider.calls).toHaveLength(1); // loop stopped; the model was not re-invoked
  });

  it("feeds an empty search result back to the model rather than failing (story 20)", async () => {
    const provider = scriptedProvider([
      { kind: "tool_call", call: { name: "search_emails", args: { query: "nobody" } } },
      { kind: "text", text: "I didn't find any emails matching that." },
    ]);
    const registry = recordingRegistry([{ ok: true, value: [] }]); // empty is success, not failure
    const { agent } = makeAgent(provider, registry);

    const reply = await agent.respond("t1", "any emails from nobody?");

    expect(reply).toEqual({ kind: "text", text: "I didn't find any emails matching that." });
    expect(provider.calls).toHaveLength(2); // the model was re-invoked with the empty result
    expect(provider.calls[1]!.conversation.at(-1)).toEqual({
      role: "tool_result",
      name: "search_emails",
      result: [],
    });
  });

  it("stops with a safe message if the model never stops calling tools", async () => {
    const provider = scriptedProvider([
      { kind: "tool_call", call: { name: "search_emails", args: {} } }, // scripted to repeat forever
    ]);
    const registry = recordingRegistry([{ ok: true, value: [] }]);
    const { agent } = makeAgent(provider, registry);

    const reply = await agent.respond("t1", "loop forever");

    expect(textOf(reply)).toContain("stuck");
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

  it("advertises the gated send_email tool to the model", async () => {
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
    expect(r2.key).toBe(r1.key); // same preview, edited in place
    expect(r2.draft).toEqual(edited);
    expect(confirmation.pendingCount).toBe(1); // not stacked into a second pending send

    await confirmation.confirm(r2.key);
    expect(sender.sent).toEqual([edited]); // only the edited draft goes out
  });
});
