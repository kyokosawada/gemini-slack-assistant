import type { EmailDraft } from "../email/sender";

/**
 * Confirmation manager — gates irreversible actions (see PRD).
 *
 * `send_email` (and later `create_event`) do not execute on the model's
 * request. The bot posts a Block Kit preview with Send/Cancel buttons and
 * records a pending action here; the action runs only when the Send button
 * event fires (`confirm`); Cancel discards it. The manager is deliberately
 * action-agnostic — it stores a preview to render and an `execute` thunk to
 * run, so the same gate serves email today and calendar events tomorrow.
 */
export interface PendingAction {
  /** What to show the user in the preview (rendered by the Slack layer). */
  preview: EmailDraft;
  /** The irreversible work, run only on confirm. */
  execute: () => Promise<void>;
}

/** What happened when the Send button fired. */
export type ConfirmOutcome =
  | { status: "executed"; preview: EmailDraft }
  | { status: "not_found" }
  | { status: "failed"; preview: EmailDraft; error: string };

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
