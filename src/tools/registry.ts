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
import type { ToolCall, ToolDefinition } from "../model/provider";

/**
 * The result of running one tool. A read tool that simply finds nothing still
 * succeeds (`ok: true` with empty data); only a genuine failure — an API error,
 * expired auth, or an unknown tool — is `ok: false`, which the agent loop turns
 * into a clear error reply rather than feeding back to the model.
 */
export type ToolOutcome =
  | { ok: true; value: unknown }
  | { ok: false; error: string };

export interface ToolRegistry {
  /** Tool definitions advertised to the model on every turn. */
  readonly definitions: ToolDefinition[];
  /** Dispatch a model-requested tool call to its implementation. */
  execute(call: ToolCall): Promise<ToolOutcome>;
}

/**
 * One tool: its definition (advertised to the model) paired with the function
 * that runs it. The model can only *request* a tool by name; the registry holds
 * the implementation, so the model never touches credentials or Google directly.
 */
export interface Tool {
  readonly definition: ToolDefinition;
  run(args: Record<string, unknown>): Promise<unknown>;
}

/**
 * Build the registry the agent loop talks to. Dispatch is by tool name; an
 * unknown name or a tool that throws becomes an `ok: false` outcome carrying the
 * cause, which the loop reports as a clear error instead of a silent success.
 */
export function createToolRegistry(tools: Tool[]): ToolRegistry {
  const byName = new Map(tools.map((t) => [t.definition.name, t]));

  return {
    definitions: tools.map((t) => t.definition),

    async execute(call) {
      const tool = byName.get(call.name);
      if (!tool) return { ok: false, error: `unknown tool: ${call.name}` };
      try {
        return { ok: true, value: await tool.run(call.args) };
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) };
      }
    },
  };
}
