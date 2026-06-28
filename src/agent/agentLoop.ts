import type { Message, ModelProvider, ModelReply, ToolCall, ToolDefinition } from "../model/provider";
import type { ToolRegistry } from "../tools/registry";
import type { ConfirmationManager, PendingAction, Preview } from "../confirmation/confirmationManager";
import type { EmailDraft, EmailSender } from "../email/sender";
import type { EventBooker, EventDraft } from "../calendar/booker";

const PROVIDER_ERROR = "⚠️ Sorry — I couldn't reach the model just now. Please try again.";
const ITERATION_LIMIT_ERROR =
  "⚠️ Sorry — I got stuck working on that and stopped. Please try rephrasing your request.";
const toolError = (detail: string) =>
  `⚠️ Sorry — a tool failed (${detail}). Nothing was completed, so please try again or check my access.`;

/** Safety net so a model that keeps calling tools can never loop forever. */
const MAX_ITERATIONS = 8;

/**
 * The *gated* tools. Unlike the registry's read tools, these do not execute on
 * the model's request: when the model calls one, the loop parks a confirmation
 * and returns a preview for the Slack Confirm/Cancel buttons. Their definitions
 * are advertised alongside the registry's so the model can call them.
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

export const CREATE_EVENT_TOOL: ToolDefinition = {
  name: "create_event",
  description:
    "Propose a calendar event for the user to review. Does NOT create it — the user must click Confirm.",
  parameters: {
    type: "object",
    properties: {
      title: { type: "string", description: "Event title" },
      start: { type: "string", description: "Event start as an RFC3339 timestamp" },
      duration: { type: "number", description: "Event duration in minutes" },
      attendees: {
        type: "array",
        items: { type: "string" },
        description: "Attendee email addresses to invite (optional)",
      },
    },
    required: ["title", "start", "duration"],
  },
};

/**
 * What one turn yields: zero or more gated proposals (each a Block Kit preview
 * with Confirm/Cancel) followed by the model's closing text, posted in order.
 * A plain answer is a single `text`; a "reply and book it" request is two
 * `confirm`s — one per gated action — each resolved independently by its button.
 */
export type AgentReply =
  | { kind: "text"; text: string }
  | { kind: "confirm"; key: string; preview: Preview };

export interface AgentLoop {
  /** Handle one user message on the given conversation thread. */
  respond(threadKey: string, text: string): Promise<AgentReply[]>;
}

/** Which gated tool a pending action belongs to — used to edit the live one in place. */
type GatedKind = "email" | "event";

/**
 * The reasoning module — the agent loop (see PRD).
 *
 * On each turn it sends the conversation plus the available tool definitions
 * (the registry's read tools + the gated send_email and create_event) to the
 * model. The model replies with a final text answer, a request to call a read
 * tool (executed via the registry, result fed back, model re-invoked), or a
 * gated tool call. A gated call is *not* executed: the loop parks a pending
 * action with the confirmation manager, feeds an "awaiting confirmation" result
 * back so the model can keep going, and remembers the preview. This lets a
 * single multi-step request — "reply to Jane and book a 30-min intro" — chain
 * tools and gate the email and the booking as two separate confirmations,
 * returned together for the Slack layer to post in order. A re-proposed action
 * of the same kind on the same thread edits that live preview in place.
 *
 * A failed turn (model unreachable, or a read tool that errors) leaves the
 * thread's history exactly as it was before the message, so the failure never
 * poisons later turns and is never reported as a silent success.
 */
export function createAgentLoop(
  provider: ModelProvider,
  registry: ToolRegistry,
  confirmation: ConfirmationManager,
  emailSender: EmailSender,
  booker: EventBooker,
): AgentLoop {
  // Per-thread conversation history, held in memory for the life of the process.
  const conversations = new Map<string, Message[]>();
  // The live pending confirmation per thread, per gated kind, so an edit
  // updates that preview in place — and an email and an event stay independent.
  const activePending = new Map<string, Partial<Record<GatedKind, string>>>();

  const tools = [...registry.definitions, SEND_EMAIL_TOOL, CREATE_EVENT_TOOL];

  /** Park a new pending action, or update the thread's live one of this kind. */
  function parkOrUpdate(threadKey: string, kind: GatedKind, action: PendingAction): string {
    const live = activePending.get(threadKey) ?? {};
    const existing = live[kind];
    const key = existing && confirmation.update(existing, action) ? existing : confirmation.propose(action);
    live[kind] = key;
    activePending.set(threadKey, live);
    return key;
  }

  return {
    async respond(threadKey, text) {
      const history = conversations.get(threadKey) ?? [];
      conversations.set(threadKey, history);

      // Where to rewind to if this turn fails, so history isn't poisoned.
      const baseLength = history.length;
      history.push({ role: "user", text });

      // Gated proposals parked this turn, in the order the model raised them.
      const proposals: AgentReply[] = [];

      for (let i = 0; i < MAX_ITERATIONS; i++) {
        // Send an immutable snapshot so later turns don't mutate what was sent.
        let reply: ModelReply;
        try {
          reply = await provider.generate([...history], tools);
        } catch {
          history.length = baseLength;
          return proposals.length ? proposals : [{ kind: "text", text: PROVIDER_ERROR }];
        }

        if (reply.kind === "text") {
          history.push({ role: "assistant", text: reply.text });
          return [...proposals, { kind: "text", text: reply.text }];
        }

        // Gated send: park (or edit the live draft), feed an awaiting-confirm
        // result back so the model can continue, and remember the preview.
        if (reply.call.name === SEND_EMAIL_TOOL.name) {
          const draft = toDraft(reply.call.args);
          const preview = { kind: "email", ...draft } as const;
          const key = parkOrUpdate(threadKey, "email", { preview, execute: () => emailSender.send(draft) });
          proposals.push({ kind: "confirm", key, preview });
          recordGated(history, reply.call, "Draft shown to the user; it sends only if they click Send.");
          continue;
        }

        // Gated booking: same gate, a different irreversible action.
        if (reply.call.name === CREATE_EVENT_TOOL.name) {
          const draft = toEventDraft(reply.call.args);
          const key = parkOrUpdate(threadKey, "event", { preview: draft, execute: () => booker.book(draft) });
          proposals.push({ kind: "confirm", key, preview: draft });
          recordGated(history, reply.call, "Event shown to the user; it's booked only if they click Confirm.");
          continue;
        }

        // Read tool: record the request, run it via the registry, feed back.
        history.push({ role: "tool_call", call: reply.call });
        const outcome = await registry.execute(reply.call);
        if (!outcome.ok) {
          history.length = baseLength;
          return [{ kind: "text", text: toolError(outcome.error) }];
        }
        history.push({ role: "tool_result", name: reply.call.name, result: outcome.value });
      }

      history.length = baseLength;
      return proposals.length ? proposals : [{ kind: "text", text: ITERATION_LIMIT_ERROR }];
    },
  };
}

/**
 * Record a gated tool call as a normal call/result pair: the request the model
 * made plus an "awaiting confirmation" response, so the conversation stays a
 * valid call→result transcript and the model can chain a further tool or finish.
 */
function recordGated(history: Message[], call: ToolCall, note: string): void {
  history.push({ role: "tool_call", call });
  history.push({ role: "tool_result", name: call.name, result: { status: "awaiting_confirmation", note } });
}

/** Coerce the model's loosely-typed tool args into an {@link EmailDraft}. */
function toDraft(args: Record<string, unknown>): EmailDraft {
  return {
    to: String(args.to ?? ""),
    subject: String(args.subject ?? ""),
    body: String(args.body ?? ""),
  };
}

/** Coerce the model's loosely-typed tool args into an {@link EventDraft}. */
function toEventDraft(args: Record<string, unknown>): EventDraft {
  const attendees = Array.isArray(args.attendees) ? args.attendees.map(String) : [];
  return {
    kind: "event",
    title: String(args.title ?? ""),
    start: String(args.start ?? ""),
    durationMin: Number(args.duration ?? 0),
    attendees,
  };
}
