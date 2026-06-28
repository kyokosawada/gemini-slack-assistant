import type { EmailDraft } from "../email/sender";
import type { EventDraft } from "../calendar/booker";

/**
 * What a pending action shows the user — an email draft or an event proposal,
 * tagged with `kind` so the Slack layer renders the right preview and the right
 * receipt. The manager itself never inspects it; it just hands it back on
 * confirm. Email drafts predate the union, so the `kind` tag is grafted on here
 * rather than baked into {@link EmailDraft} (the email sender's own domain type).
 */
export type Preview = ({ kind: "email" } & EmailDraft) | EventDraft;

/**
 * Confirmation manager — gates irreversible actions (see PRD).
 *
 * `send_email` and `create_event` do not execute on the model's request. The
 * bot posts a Block Kit preview with Confirm/Cancel buttons and records a
 * pending action here; the action runs only when the Confirm button event fires
 * (`confirm`); Cancel discards it. The manager is deliberately action-agnostic —
 * it stores a {@link Preview} to render and an `execute` thunk to run, so the
 * same gate serves email and calendar events alike.
 */
export interface PendingAction {
  /** What to show the user in the preview (rendered by the Slack layer). */
  preview: Preview;
  /** The irreversible work, run only on confirm. */
  execute: () => Promise<void>;
}

/** What happened when the Confirm button fired. */
export type ConfirmOutcome =
  | { status: "executed"; preview: Preview }
  | { status: "not_found" }
  | { status: "failed"; preview: Preview; error: string };

export interface ConfirmationManager {
  readonly pendingCount: number;
  /** Park an action and return the opaque key the buttons carry. */
  propose(action: PendingAction): string;
  /** Run the parked action for `key` (once), then clear it. */
  confirm(key: string): Promise<ConfirmOutcome>;
  /** Discard the parked action for `key` without running it. */
  cancel(key: string): boolean;
  /** Replace the parked action for `key` (an edited draft); false if none. */
  update(key: string, action: PendingAction): boolean;
}

export function createConfirmationManager(): ConfirmationManager {
  const pending = new Map<string, PendingAction>();
  let seq = 0;

  return {
    get pendingCount() {
      return pending.size;
    },
    propose(action) {
      const key = `pending-${++seq}`;
      pending.set(key, action);
      return key;
    },
    async confirm(key) {
      const action = pending.get(key);
      if (!action) return { status: "not_found" };
      pending.delete(key); // clear first, so a double-click can never send twice
      try {
        await action.execute();
        return { status: "executed", preview: action.preview };
      } catch (cause) {
        pending.set(key, action); // nothing went out — re-park it so the user can retry
        const error = cause instanceof Error ? cause.message : String(cause);
        return { status: "failed", preview: action.preview, error };
      }
    },
    cancel(key) {
      return pending.delete(key);
    },
    update(key, action) {
      if (!pending.has(key)) return false;
      pending.set(key, action);
      return true;
    },
  };
}
