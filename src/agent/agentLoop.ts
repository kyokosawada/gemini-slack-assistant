import type { Message, ModelProvider, ModelReply, ToolDefinition } from "../model/provider";
import type { ConfirmationManager } from "../confirmation/confirmationManager";
import type { EmailDraft, EmailSender } from "../email/sender";

const PROVIDER_ERROR = "⚠️ Sorry — I couldn't reach the model just now. Please try again.";
const NO_TOOLS_YET = "⚠️ I can't use that tool yet — Gmail search and Calendar are coming in a later update.";

/**
 * The one tool wired in this slice. Sending is gated: when the model calls this,
 * the loop parks a confirmation rather than sending. Read tools (search_emails,
 * etc.) arrive with the tool registry in a later slice.
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
 * Sends the conversation (plus tool definitions) to the model through the
 * swappable provider and returns its reply. A `send_email` request is *gated*:
 * rather than sending, the loop parks a pending action with the confirmation
 * manager and returns a `confirm` reply for the Slack layer to preview.
 */
export function createAgentLoop(
  provider: ModelProvider,
  confirmation: ConfirmationManager,
  emailSender: EmailSender,
): AgentLoop {
  // Per-thread conversation history, held in memory for the life of the process.
  const conversations = new Map<string, Message[]>();
  // The live pending send per thread, so an edit updates that preview in place.
  const activeSend = new Map<string, string>();

  return {
    async respond(threadKey, text) {
      const history = conversations.get(threadKey) ?? [];
      history.push({ role: "user", text });
      conversations.set(threadKey, history);

      // Send an immutable snapshot so later turns don't mutate what was sent.
      let reply: ModelReply;
      try {
        reply = await provider.generate([...history], [SEND_EMAIL_TOOL]);
      } catch {
        history.pop(); // a failed turn must not poison the thread's history
        return { kind: "text", text: PROVIDER_ERROR };
      }

      if (reply.kind === "tool_call" && reply.call.name === SEND_EMAIL_TOOL.name) {
        const draft = toDraft(reply.call.args);
        const action = { preview: draft, execute: () => emailSender.send(draft) };
        // If this thread already has a live draft, edit it in place; else park anew.
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

      const replyText = reply.kind === "text" ? reply.text : NO_TOOLS_YET;
      history.push({ role: "assistant", text: replyText });
      return { kind: "text", text: replyText };
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
