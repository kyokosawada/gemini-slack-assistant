/**
 * Thin model-provider interface (see PRD).
 *
 * The agent loop talks to the model only through this seam, so Gemini (free
 * tier, via the official Google AI SDK) can be swapped for another provider
 * with a small change. The model never holds credentials or calls Google
 * directly — it can only request tools, which the bot executes.
 *
 * Shape (chat + tool-calling) is defined in a later slice.
 *
 * Stub for the tracer-bullet slice (issue #2).
 */
export interface ModelProvider {
  readonly name: string;
}

export function createModelProvider(): ModelProvider {
  throw new Error("model provider not implemented yet");
}
