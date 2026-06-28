import type { KnownBlock } from "@slack/types";
import type { AgentReply } from "../agent/agentLoop";
import { buildSendPreview } from "./sendPreview";
import { buildEventPreview } from "./eventPreview";

/** What we hand to Slack to post: text always (also the notification fallback), blocks for a preview. */
export interface SlackMessage {
  text: string;
  blocks?: KnownBlock[];
}

export type Say = (message: SlackMessage) => Promise<unknown>;

/**
 * Generates the replies for the user's normalized text — the agent-loop seam.
 * Returns a list: a plain answer is one text, while a multi-step request can
 * yield several (an email preview, an event preview, a closing note), each
 * posted as its own Slack message.
 */
export type Responder = (text: string) => Promise<AgentReply[]>;

export interface IncomingMessage {
  text?: string;
}

const NUDGE = "got it — what can I help you with?";

/** Turn an agent reply into a Slack message payload (pure). */
export function renderReply(reply: AgentReply): SlackMessage {
  if (reply.kind === "confirm") {
    const preview = reply.preview;
    if (preview.kind === "email") {
      return {
        text: `📧 Draft email to ${preview.to} — review and click Send.`,
        blocks: buildSendPreview(reply.key, preview),
      };
    }
    return {
      text: `📅 Proposed event "${preview.title}" — review and click Confirm.`,
      blocks: buildEventPreview(reply.key, preview),
    };
  }
  return { text: reply.text };
}

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
  respond: Responder,
): Promise<void> {
  const text = normalizeText(message.text);
  if (!text) {
    await say({ text: NUDGE });
    return;
  }
  // A turn can produce several replies (e.g. two confirmations); post each.
  for (const reply of await respond(text)) {
    await say(renderReply(reply));
  }
}
