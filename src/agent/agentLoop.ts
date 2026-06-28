import type { Message, ModelProvider, ModelReply, ToolDefinition } from "../model/provider";
import type { ToolRegistry } from "../tools/registry";
import type { ConfirmationManager } from "../confirmation/confirmationManager";
import type { EmailDraft, EmailSender } from "../email/sender";

const PROVIDER_ERROR = "⚠️ Sorry — I couldn't reach the model just now. Please try again.";
const ITERATION_LIMIT_ERROR =
  "⚠️ Sorry — I got stuck working on that and stopped. Please try rephrasing your request.";
const toolError = (detail: string) =>
  `⚠️ Sorry — a tool failed (${detail}). Nothing was completed, so please try again or check my access.`;

/** Safety net so a model that keeps calling tools can never loop forever. */
const MAX_ITERATIONS = 8;

/**
 * The one *gated* tool. Unlike the registry's read tools, sending does not
 * execute on the model's request: when the model calls this, the loop parks a
 * confirmation and returns a preview for the Slack Send/Cancel buttons. Its
 * definition is advertised alongside the registry's so the model can call it.
 */
export const SEND_EMAIL_TOOL: ToolDefinition = {
  name: "send_email",
  description:
    "Draft an email for the user to review. Does NOT send — the user must click Send to confirm.",
  parameters: {
    type: "object",
    properties: {
      to: { type: "string", description: "Recipient email address" },
      subject: { type: "string", description: "Email subject line" },
      body: { type: "string", description: "Plain-text email body" },
    },
    required: ["to", "subject", "body"],
  },
};

/**
 * What one turn yields: a plain text answer to post, or a gated send the Slack
 * layer should render as a Block Kit preview with Send/Cancel buttons.
 */
export type AgentReply =
  | { kind: "text"; text: string }
  | { kind: "confirm"; key: string; draft: EmailDraft };

export interface AgentLoop {
  /** Handle one user message on the given conversation thread. */
  respond(threadKey: string, text: string): Promise<AgentReply>;
}

/**
 * The reasoning module — the agent loop (see PRD).
 *
 * On each turn it sends the conversation plus the available tool definitions
 * (the registry's read tools + the gated send_email) to the model. The model
 * replies with a final text answer, a request to call a read tool (executed via
 * the registry, result fed back, model re-invoked), or a `send_email` call —
 * which is *gated*: the loop parks a pending action with the confirmation
 * manager and returns a `confirm` reply for the Slack layer to preview, sending
 * nothing until the Send button fires. A re-proposed send on the same thread
 * edits the live draft in place.
 *
 * A failed turn (model unreachable, or a tool that errors) leaves the thread's
 * history exactly as it was before the message, so the failure never poisons
 * later turns and is never reported as a silent success.
 */
export function createAgentLoop(
  provider: ModelProvider,
  registry: ToolRegistry,
  confirmation: ConfirmationManager,
  emailSender: EmailSender,
): AgentLoop {
  // Per-thread conversation history, held in memory for the life of the process.
  const conversations = new Map<string, Message[]>();
  // The live pending send per thread, so an edit updates that preview in place.
  const activeSend = new Map<string, string>();

  const tools = [...registry.definitions, SEND_EMAIL_TOOL];

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
          reply = await provider.generate([...history], tools);
        } catch {
          history.length = baseLength;
          return { kind: "text", text: PROVIDER_ERROR };
        }

        if (reply.kind === "text") {
          history.push({ role: "assistant", text: reply.text });
          return { kind: "text", text: reply.text };
        }

        // Gated send: park a confirmation (or edit the live draft) and stop —
        // nothing is sent until the Send button fires.
        if (reply.call.name === SEND_EMAIL_TOOL.name) {
          const draft = toDraft(reply.call.args);
          const action = { preview: draft, execute: () => emailSender.send(draft) };
          const existing = activeSend.get(threadKey);
          const key =
            existing && confirmation.update(existing, action)
              ? existing
              : confirmation.propose(action);
          activeSend.set(threadKey, key);
          // Record the proposed draft so a follow-up ("make it shorter") has context.
          history.push({ role: "assistant", text: describeDraft(draft) });
          return { kind: "confirm", key, draft };
        }

        // Read tool: record the request, run it via the registry, feed back.
        history.push({ role: "tool_call", call: reply.call });
        const outcome = await registry.execute(reply.call);
        if (!outcome.ok) {
          history.length = baseLength;
          return { kind: "text", text: toolError(outcome.error) };
        }
        history.push({ role: "tool_result", name: reply.call.name, result: outcome.value });
      }

      history.length = baseLength;
      return { kind: "text", text: ITERATION_LIMIT_ERROR };
    },
  };
}

/** Coerce the model's loosely-typed tool args into an {@link EmailDraft}. */
function toDraft(args: Record<string, unknown>): EmailDraft {
  return {
    to: String(args.to ?? ""),
    subject: String(args.subject ?? ""),
    body: String(args.body ?? ""),
  };
}

/** A compact record of a proposed draft, kept in history for edit turns. */
function describeDraft(draft: EmailDraft): string {
  return `Drafted an email — To: ${draft.to}; Subject: ${draft.subject}; Body: ${draft.body}`;
}
