import type { Message, ModelProvider, ModelReply } from "../model/provider";

const PROVIDER_ERROR = "⚠️ Sorry — I couldn't reach the model just now. Please try again.";
const NO_TOOLS_YET = "⚠️ I can't use tools yet — Gmail and Calendar are coming in a later update.";

export interface AgentLoop {
  /** Handle one user message on the given conversation thread, returning the reply text. */
  respond(threadKey: string, text: string): Promise<string>;
}

/**
 * The reasoning module — the agent loop (see PRD).
 *
 * Sends the conversation (plus tool definitions — empty for now) to the model
 * through the swappable provider, and returns the model's reply for posting to
 * Slack.
 */
export function createAgentLoop(provider: ModelProvider): AgentLoop {
  // Per-thread conversation history, held in memory for the life of the process.
  const conversations = new Map<string, Message[]>();

  return {
    async respond(threadKey, text) {
      const history = conversations.get(threadKey) ?? [];
      history.push({ role: "user", text });
      conversations.set(threadKey, history);

      // Send an immutable snapshot so later turns don't mutate what was sent.
      let reply: ModelReply;
      try {
        reply = await provider.generate([...history], []);
      } catch {
        history.pop(); // a failed turn must not poison the thread's history
        return PROVIDER_ERROR;
      }
      const replyText = reply.kind === "text" ? reply.text : NO_TOOLS_YET;

      history.push({ role: "assistant", text: replyText });
      return replyText;
    },
  };
}
