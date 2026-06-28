import type { Message, ModelProvider, ModelReply } from "../model/provider";
import type { ToolRegistry } from "../tools/registry";

const PROVIDER_ERROR = "⚠️ Sorry — I couldn't reach the model just now. Please try again.";
const ITERATION_LIMIT_ERROR =
  "⚠️ Sorry — I got stuck working on that and stopped. Please try rephrasing your request.";
const toolError = (detail: string) =>
  `⚠️ Sorry — a tool failed (${detail}). Nothing was completed, so please try again or check my access.`;

/** Safety net so a model that keeps calling tools can never loop forever. */
const MAX_ITERATIONS = 8;

export interface AgentLoop {
  /** Handle one user message on the given conversation thread, returning the reply text. */
  respond(threadKey: string, text: string): Promise<string>;
}

/**
 * The reasoning module — the agent loop (see PRD).
 *
 * On each turn it sends the conversation plus the registry's tool definitions to
 * the model. The model replies with either a final text answer (returned to
 * Slack) or a request to call a tool; on a tool call the loop executes it via
 * the registry, feeds the result back into the conversation, and re-invokes the
 * model — repeating until the model produces a final answer.
 *
 * A failed turn (model unreachable, or a tool that errors) leaves the thread's
 * history exactly as it was before the message, so the failure never poisons
 * later turns and is never reported as a silent success.
 */
export function createAgentLoop(provider: ModelProvider, registry: ToolRegistry): AgentLoop {
  // Per-thread conversation history, held in memory for the life of the process.
  const conversations = new Map<string, Message[]>();

  return {
    async respond(threadKey, text) {
      const history = conversations.get(threadKey) ?? [];
      conversations.set(threadKey, history);

      // Where to rewind to if this turn fails, so history isn't poisoned.
      const baseLength = history.length;
      history.push({ role: "user", text });

      for (let i = 0; i < MAX_ITERATIONS; i++) {
        // Send an immutable snapshot so later turns don't mutate what was sent.
        let reply: ModelReply;
        try {
          reply = await provider.generate([...history], registry.definitions);
        } catch {
          history.length = baseLength;
          return PROVIDER_ERROR;
        }

        if (reply.kind === "text") {
          history.push({ role: "assistant", text: reply.text });
          return reply.text;
        }

        // The model asked to call a tool: record the request, run it, feed back.
        history.push({ role: "tool_call", call: reply.call });
        const outcome = await registry.execute(reply.call);
        if (!outcome.ok) {
          history.length = baseLength;
          return toolError(outcome.error);
        }
        history.push({ role: "tool_result", name: reply.call.name, result: outcome.value });
      }

      history.length = baseLength;
      return ITERATION_LIMIT_ERROR;
    },
  };
}
