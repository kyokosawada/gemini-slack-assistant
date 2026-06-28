/**
 * A single turn in the conversation. Plain `user`/`assistant` turns carry text;
 * once tools enter the loop a turn may instead record the model's request to
 * call a tool (`tool_call`) or the result the bot fed back (`tool_result`).
 */
export type Message =
  | { role: "user"; text: string }
  | { role: "assistant"; text: string }
  | { role: "tool_call"; call: ToolCall }
  | { role: "tool_result"; name: string; result: unknown };

/**
 * A tool the model may call (Gmail/Calendar). The set is empty until issue #4
 * registers the first real tools.
 */
export interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

/** The model's request to invoke a tool. */
export interface ToolCall {
  name: string;
  args: Record<string, unknown>;
}

/** What the model returns: a final answer, or a request to call a tool. */
export type ModelReply =
  | { kind: "text"; text: string }
  | { kind: "tool_call"; call: ToolCall };

/**
 * Thin, swappable model contract (see PRD). The agent loop talks to the model
 * only through this interface, so the implementation (Gemini today) can be
 * swapped in a single file. The model never holds credentials or calls Google
 * directly — it can only *request* a tool, which the bot executes.
 */
export interface ModelProvider {
  readonly name: string;
  generate(conversation: Message[], tools: ToolDefinition[]): Promise<ModelReply>;
}
