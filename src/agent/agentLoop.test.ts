import { describe, it, expect } from "bun:test";
import { createAgentLoop } from "./agentLoop";
import type {
  Message,
  ModelProvider,
  ModelReply,
  ToolCall,
  ToolDefinition,
} from "../model/provider";
import type { ToolOutcome, ToolRegistry } from "../tools/registry";

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

/** A registry that advertises no tools — used by text-only conversation tests. */
const noTools = (): ToolRegistry => ({ definitions: [], execute: async () => ({ ok: false, error: "no tools" }) });

describe("createAgentLoop", () => {
  it("sends the user message to the provider and returns its text reply", async () => {
    const provider = scriptedProvider([{ kind: "text", text: "hi back" }]);

    const agent = createAgentLoop(provider, noTools());
    const reply = await agent.respond("thread-1", "hello");

    expect(reply).toBe("hi back");
    expect(provider.calls[0]!.conversation.at(-1)).toEqual({ role: "user", text: "hello" });
  });

  it("persists conversation context per thread across messages", async () => {
    const provider = scriptedProvider([
      { kind: "text", text: "first reply" },
      { kind: "text", text: "second reply" },
    ]);
    const agent = createAgentLoop(provider, noTools());

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
    const agent = createAgentLoop(provider, noTools());

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
    const agent = createAgentLoop(provider, noTools());

    const reply = await agent.respond("t1", "hello");

    expect(reply).toContain("couldn't reach the model");
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
    const registry = recordingRegistry(
      [{ ok: true, value: [{ id: "m1", subject: "Lead A" }] }],
      [searchDef],
    );

    const agent = createAgentLoop(provider, registry);
    const reply = await agent.respond("t1", "what leads came in today?");

    expect(reply).toBe("You have 2 new leads.");
    // the tool the model asked for was actually executed
    expect(registry.calls).toEqual([{ name: "search_emails", args: { query: "leads today" } }]);
    // tool definitions are advertised to the model
    expect(provider.calls[0]!.tools).toEqual([searchDef]);
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
    const agent = createAgentLoop(provider, registry);

    const first = await agent.respond("t1", "find emails");
    expect(first).toContain("tool failed");
    expect(first).toContain("expired auth"); // the real cause reaches the user (story 23)

    await agent.respond("t1", "hi");
    // the failed turn left nothing behind: the next turn starts from a clean thread
    expect(provider.calls.at(-1)!.conversation).toEqual([{ role: "user", text: "hi" }]);
  });

  it("returns a clear error when the model requests a tool the registry can't run", async () => {
    const provider = scriptedProvider([
      { kind: "tool_call", call: { name: "search_emails", args: { query: "x" } } },
    ]);
    const agent = createAgentLoop(provider, noTools());

    const reply = await agent.respond("t1", "find my emails");

    expect(reply).toContain("tool failed");
    expect(provider.calls).toHaveLength(1); // loop stopped; the model was not re-invoked
  });

  it("feeds an empty search result back to the model rather than failing (story 20)", async () => {
    const provider = scriptedProvider([
      { kind: "tool_call", call: { name: "search_emails", args: { query: "nobody" } } },
      { kind: "text", text: "I didn't find any emails matching that." },
    ]);
    const registry = recordingRegistry([{ ok: true, value: [] }]); // empty is success, not failure
    const agent = createAgentLoop(provider, registry);

    const reply = await agent.respond("t1", "any emails from nobody?");

    expect(reply).toBe("I didn't find any emails matching that.");
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
    const agent = createAgentLoop(provider, registry);

    const reply = await agent.respond("t1", "loop forever");

    expect(reply).toContain("stuck");
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
    const agent = createAgentLoop(provider, noTools());

    await agent.respond("t1", "hello"); // fails
    await agent.respond("t1", "hello again"); // succeeds

    expect(seen[1]).toEqual([{ role: "user", text: "hello again" }]);
  });
});
