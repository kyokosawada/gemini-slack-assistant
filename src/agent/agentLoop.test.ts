import { describe, it, expect } from "bun:test";
import { createAgentLoop } from "./agentLoop";
import type { Message, ModelProvider, ModelReply, ToolDefinition } from "../model/provider";

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

describe("createAgentLoop", () => {
  it("sends the user message to the provider and returns its text reply", async () => {
    const provider = scriptedProvider([{ kind: "text", text: "hi back" }]);

    const agent = createAgentLoop(provider);
    const reply = await agent.respond("thread-1", "hello");

    expect(reply).toBe("hi back");
    expect(provider.calls[0]!.conversation.at(-1)).toEqual({ role: "user", text: "hello" });
  });

  it("persists conversation context per thread across messages", async () => {
    const provider = scriptedProvider([
      { kind: "text", text: "first reply" },
      { kind: "text", text: "second reply" },
    ]);
    const agent = createAgentLoop(provider);

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
    const agent = createAgentLoop(provider);

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
    const agent = createAgentLoop(provider);

    const reply = await agent.respond("t1", "hello");

    expect(reply).toContain("couldn't reach the model");
  });

  it("surfaces a clear message when the model requests a tool but none are registered", async () => {
    const provider = scriptedProvider([
      { kind: "tool_call", call: { name: "search_emails", args: { query: "x" } } },
    ]);
    const agent = createAgentLoop(provider);

    const reply = await agent.respond("t1", "find my emails");

    expect(reply).toContain("can't use tools yet");
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
    const agent = createAgentLoop(provider);

    await agent.respond("t1", "hello"); // fails
    await agent.respond("t1", "hello again"); // succeeds

    expect(seen[1]).toEqual([{ role: "user", text: "hello again" }]);
  });
});
