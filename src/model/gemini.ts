import { GoogleGenAI } from "@google/genai";
import type { Message, ModelProvider, ModelReply, ToolDefinition } from "./provider";

/** Default Gemini model — free-tier flash. Override via the optional arg. */
const DEFAULT_MODEL = "gemini-2.5-flash";

/**
 * Gemini implementation of {@link ModelProvider} (official `@google/genai` SDK).
 *
 * This is the single file to change to swap models or providers. The
 * conversation is mapped to Gemini's `contents` format (our "assistant" role
 * becomes Gemini's "model"); a function call in the response surfaces as a
 * `tool_call`, otherwise the text answer is returned.
 */
export function createGeminiProvider(
  apiKey: string,
  model: string = DEFAULT_MODEL,
): ModelProvider {
  const ai = new GoogleGenAI({ apiKey });

  return {
    name: `gemini:${model}`,
    async generate(conversation: Message[], tools: ToolDefinition[]): Promise<ModelReply> {
      const contents = conversation.map(toContent);

      const config =
        tools.length > 0
          ? { tools: [{ functionDeclarations: tools.map(toFunctionDeclaration) }] }
          : undefined;

      const response = await ai.models.generateContent({ model, contents, config });
      return toModelReply(response);
    },
  };
}

/**
 * Map a Gemini response to our {@link ModelReply}: a predicted function call
 * surfaces as a `tool_call` (taking the first call), otherwise the text answer
 * is returned. Pure, so the wire-format contract is unit-testable without a
 * network round-trip.
 */
export function toModelReply(response: {
  functionCalls?: Array<{ name?: string | null; args?: Record<string, unknown> }> | null;
  text?: string | null;
}): ModelReply {
  const calls = response.functionCalls;
  if (calls && calls.length > 0) {
    const call = calls[0]!;
    return { kind: "tool_call", call: { name: call.name ?? "", args: call.args ?? {} } };
  }
  return { kind: "text", text: response.text ?? "" };
}

function toFunctionDeclaration(tool: ToolDefinition) {
  return {
    name: tool.name,
    description: tool.description,
    parametersJsonSchema: tool.parameters,
  };
}

/**
 * Map one of our conversation turns to a Gemini `Content`. Our `assistant`
 * becomes Gemini's `model`; a `tool_call` becomes a `functionCall` part on a
 * model turn; a `tool_result` becomes a `functionResponse` part on a user turn
 * (the SDK reads the tool output from the `output` key).
 */
export function toContent(m: Message) {
  switch (m.role) {
    case "user":
      return { role: "user", parts: [{ text: m.text }] };
    case "assistant":
      return { role: "model", parts: [{ text: m.text }] };
    case "tool_call":
      return { role: "model", parts: [{ functionCall: { name: m.call.name, args: m.call.args } }] };
    case "tool_result":
      return {
        role: "user",
        parts: [{ functionResponse: { name: m.name, response: { output: m.result } } }],
      };
  }
}
