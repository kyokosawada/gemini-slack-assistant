/**
 * The reasoning module — the agent loop (see PRD).
 *
 * Receives a user message, sends the conversation plus the available tool
 * definitions to the model, and loops: the model returns either a final text
 * answer or a tool call; on a tool call the loop executes the tool, feeds the
 * result back, and re-invokes the model, repeating until a final answer is
 * produced — which is posted to Slack.
 *
 * Signature-compatible with the message handler's `Responder` seam so it can be
 * dropped in where the echo responder currently sits.
 *
 * Stub for the tracer-bullet slice (issue #2) — implemented in a later slice.
 */
export async function runAgentLoop(_text: string): Promise<string> {
  throw new Error("agent loop not implemented yet");
}
