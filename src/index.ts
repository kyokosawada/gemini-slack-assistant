import { App } from "@slack/bolt";
import { requireEnv } from "./env";
import { handleIncomingMessage } from "./slack/messageHandler";
import { createAgentLoop } from "./agent/agentLoop";
import { createGeminiProvider } from "./model/gemini";
import { createConfirmationManager } from "./confirmation/confirmationManager";
import { createEmailSender } from "./email/sender";
import { CONFIRM_ACTION_ID, CANCEL_ACTION_ID } from "./slack/sendPreview";

/**
 * Entry point: a single always-on local process that connects to Slack over
 * Socket Mode and answers @mentions and DMs with the agent loop (Gemini behind
 * the swappable provider). Irreversible sends are gated: the loop parks them in
 * the confirmation manager and the Slack Send/Cancel buttons resolve them here.
 * Conversation and pending-confirmation state are in memory, keyed per thread.
 */
const provider = createGeminiProvider(requireEnv("GEMINI_API_KEY"));
const confirmation = createConfirmationManager();
const emailSender = createEmailSender({
  user: requireEnv("GMAIL_USER"),
  appPassword: requireEnv("GMAIL_APP_PASSWORD"),
});
const agent = createAgentLoop(provider, confirmation, emailSender);

const app = new App({
  token: requireEnv("SLACK_BOT_TOKEN"),
  appToken: requireEnv("SLACK_APP_TOKEN"),
  socketMode: true,
});

// @mention in a channel → reply in the same thread; context keyed per thread.
app.event("app_mention", async ({ event, say }) => {
  const threadKey = `${event.channel}:${event.thread_ts ?? event.ts}`;
  await handleIncomingMessage(
    { text: event.text },
    (msg) => say({ ...msg, thread_ts: event.thread_ts ?? event.ts }),
    (text) => agent.respond(threadKey, text),
  );
});

// Direct message → reply in the DM; context keyed per DM channel. Only
// `message.im` is subscribed; ignore edits/deletions/joins and the bot's own.
app.message(async ({ message, say }) => {
  if (message.subtype !== undefined) return;
  const threadKey = message.channel;
  await handleIncomingMessage(
    { text: message.text },
    (msg) => say(msg),
    (text) => agent.respond(threadKey, text),
  );
});

// Send button → run the parked send. On success swap the preview for a receipt;
// on failure leave the preview intact (the action is re-parked) so Send retries.
app.action(CONFIRM_ACTION_ID, async ({ ack, action, respond }) => {
  await ack();
  if (action.type !== "button" || !action.value) return;

  const outcome = await confirmation.confirm(action.value);
  if (outcome.status === "executed") {
    await respond({ replace_original: true, text: `✅ Sent to ${outcome.preview.to}.` });
  } else if (outcome.status === "failed") {
    await respond({
      replace_original: false,
      text: `⚠️ Couldn't send: ${outcome.error}. The draft is still here — click *Send* to retry.`,
    });
  } else {
    await respond({ replace_original: true, text: "This draft has expired — please ask me again." });
  }
});

// Cancel button → discard the parked send and swap the preview for a notice.
app.action(CANCEL_ACTION_ID, async ({ ack, action, respond }) => {
  await ack();
  if (action.type !== "button" || !action.value) return;

  confirmation.cancel(action.value);
  await respond({ replace_original: true, text: "🚫 Discarded — nothing was sent." });
});

await app.start();
console.log("⚡️ Slack assistant is running (Socket Mode)");
