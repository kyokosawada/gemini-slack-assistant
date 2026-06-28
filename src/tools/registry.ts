/**
 * Tool registry — the functions exposed to the model (see PRD).
 *
 *   Gmail:    search_emails, read_email, send_email (confirm)
 *   Calendar: list_events, find_free_time, create_event (confirm)
 *
 * The model can only *request* a tool; the bot executes it. Tool definitions
 * and dispatch are added in a later slice.
 *
 * Stub for the tracer-bullet slice (issue #2).
 */
export interface ToolRegistry {
  readonly toolNames: readonly string[];
}

export function createToolRegistry(): ToolRegistry {
  throw new Error("tool registry not implemented yet");
}
