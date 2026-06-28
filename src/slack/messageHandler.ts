export type Say = (text: string) => Promise<unknown>;

export interface IncomingMessage {
  text?: string;
}

/**
 * Turns the user's (normalized) text into a reply body. This is the seam the
 * Gemini agent loop will plug into in a later slice; for the tracer bullet the
 * default responder simply echoes.
 */
export type Responder = (text: string) => Promise<string>;

const echoResponder: Responder = async (text) =>
  text ? `got it: ${text}` : "got it — what can I help you with?";

/**
 * Strip a leading Slack user-mention token (e.g. "<@U123> hi" or
 * "<@U123|name> hi") and surrounding whitespace, so an `app_mention`
 * reads the same as a DM.
 */
function normalizeText(text: string | undefined): string {
  return (text ?? "").replace(/^\s*<@[^>]+>\s*/, "").trim();
}

export async function handleIncomingMessage(
  message: IncomingMessage,
  say: Say,
  respond: Responder = echoResponder,
): Promise<void> {
  const text = normalizeText(message.text);
  const reply = await respond(text);
  await say(reply);
}
