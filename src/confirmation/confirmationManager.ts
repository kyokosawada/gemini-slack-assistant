/**
 * Confirmation manager — gates irreversible actions (see PRD).
 *
 * `send_email` and `create_event` do not execute on the model's request.
 * Instead the bot posts a Block Kit preview with Send/Confirm and Cancel
 * buttons and records a pending action; the action executes only when the
 * corresponding button event fires (Cancel discards it).
 *
 * Pending-action tracking and button handling are added in a later slice.
 *
 * Stub for the tracer-bullet slice (issue #2).
 */
export interface ConfirmationManager {
  readonly pendingCount: number;
}

export function createConfirmationManager(): ConfirmationManager {
  throw new Error("confirmation manager not implemented yet");
}
