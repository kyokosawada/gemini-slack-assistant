import { App } from "@slack/bolt";
import { requireEnv } from "./env";
import { handleIncomingMessage } from "./slack/messageHandler";

/**
 * Tracer-bullet entry point (issue #2): a single always-on local process that
 * connects to Slack over Socket Mode (no public URL) and echoes replies to
 * @mentions and DMs. Gemini, tools, and confirmations land in later slices —
 * see the stubs under src/agent, src/model, src/tools, src/confirmation.
 */
const app = new App({
  token: requireEnv("SLACK_BOT_TOKEN"),
  appToken: requireEnv("SLACK_APP_TOKEN"),
  socketMode: true,
});

// @mention in a channel → reply in the same thread.
app.event("app_mention", async ({ event, say }) => {
  await handleIncomingMessage({ text: event.text }, (text) =>
    say({ text, thread_ts: event.thread_ts ?? event.ts }),
  );
});

// Direct message → reply in the DM. Only `message.im` is subscribed, so this
// fires for DMs; ignore edits/deletions/joins and the bot's own messages.
app.message(async ({ message, say }) => {
  if (message.subtype !== undefined) return;
  await handleIncomingMessage({ text: message.text }, (text) => say(text));
});

await app.start();
console.log("⚡️ Slack assistant is running (Socket Mode)");
