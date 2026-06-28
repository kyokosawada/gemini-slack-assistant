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
      const contents = conversation.map((m) => ({
        role: m.role === "assistant" ? "model" : "user",
        parts: [{ text: m.text }],
      }));

      const config =
        tools.length > 0
          ? { tools: [{ functionDeclarations: tools.map(toFunctionDeclaration) }] }
          : undefined;

      const response = await ai.models.generateContent({ model, contents, config });

      const calls = response.functionCalls;
      if (calls && calls.length > 0) {
        const call = calls[0]!;
        return { kind: "tool_call", call: { name: call.name ?? "", args: call.args ?? {} } };
      }

      return { kind: "text", text: response.text ?? "" };
    },
  };
}

function toFunctionDeclaration(tool: ToolDefinition) {
  return {
    name: tool.name,
    description: tool.description,
    parametersJsonSchema: tool.parameters,
  };
}
