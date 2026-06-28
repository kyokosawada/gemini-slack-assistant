import { App } from "@slack/bolt";
import { requireEnv } from "./env";
import { handleIncomingMessage } from "./slack/messageHandler";
import { createAgentLoop } from "./agent/agentLoop";
import { createGeminiProvider } from "./model/gemini";
import { loadAuthorizedClient } from "./google/auth";
import { createGmailApi } from "./google/gmailApi";
import { createCalendarApi } from "./google/calendarApi";
import { createToolRegistry } from "./tools/registry";
import { searchEmailsTool, readEmailTool } from "./tools/gmail";
import { listEventsTool, findFreeTimeTool } from "./tools/calendar";
import { createConfirmationManager } from "./confirmation/confirmationManager";
import { createEmailSender } from "./email/sender";
import { createEventBooker } from "./calendar/booker";
import { CONFIRM_ACTION_ID, CANCEL_ACTION_ID } from "./slack/sendPreview";

/**
 * Entry point: a single always-on local process that connects to Slack over
 * Socket Mode and answers @mentions and DMs with the agent loop (Gemini behind
 * the swappable provider). The model can call Gmail/Calendar read tools via the
 * registry; irreversible sends are gated — the loop parks them in the
 * confirmation manager and the Slack Send/Cancel buttons resolve them here.
 * Conversation and pending-confirmation state are in memory, keyed per thread.
 */
const provider = createGeminiProvider(requireEnv("GEMINI_API_KEY"));

// Gmail + Calendar read tools, authorized via the cached OAuth token (run `bun
// run authorize` first to mint token.json). The model can request these; the
// registry executes them and the loop feeds results back for summarizing.
const auth = loadAuthorizedClient();
const gmail = createGmailApi(auth);
const calendar = createCalendarApi(auth);
const registry = createToolRegistry([
  searchEmailsTool(gmail),
  readEmailTool(gmail),
  listEventsTool(calendar),
  findFreeTimeTool(calendar),
]);

// Gated actions: send_email and create_event are parked here and only run on a
// Confirm click. The booker reuses the same authorized Calendar client as the
// read tools (the `calendar.events` scope already covers creating events).
const confirmation = createConfirmationManager();
const emailSender = createEmailSender({
  user: requireEnv("GMAIL_USER"),
  appPassword: requireEnv("GMAIL_APP_PASSWORD"),
});
const booker = createEventBooker(calendar);
const agent = createAgentLoop(provider, registry, confirmation, emailSender, booker);

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
    const receipt =
      outcome.preview.kind === "email"
        ? `✅ Sent to ${outcome.preview.to}.`
        : `📅 Booked "${outcome.preview.title}" for ${outcome.preview.start}.`;
    await respond({ replace_original: true, text: receipt });
  } else if (outcome.status === "failed") {
    const noun = outcome.preview.kind === "email" ? "send" : "book";
    await respond({
      replace_original: false,
      text: `⚠️ Couldn't ${noun}: ${outcome.error}. It's still here — click *Confirm* to retry.`,
    });
  } else {
    await respond({ replace_original: true, text: "This has expired — please ask me again." });
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
