import { App } from "@slack/bolt";
import { requireEnv } from "./env";
import { handleIncomingMessage } from "./slack/messageHandler";
import { createAgentLoop } from "./agent/agentLoop";
import { createGeminiProvider } from "./model/gemini";
import { loadAuthorizedClient } from "./google/auth";
import { createGmailApi } from "./google/gmailApi";
import { createToolRegistry } from "./tools/registry";
import { searchEmailsTool, readEmailTool } from "./tools/gmail";

/**
 * Entry point (issue #3): a single always-on local process that connects to
 * Slack over Socket Mode and answers @mentions and DMs with the agent loop,
 * which reasons via Gemini behind the swappable provider interface. Per-thread
 * conversation context is kept in memory by the agent loop; here we just map
 * each Slack surface to a stable thread key.
 */
const provider = createGeminiProvider(requireEnv("GEMINI_API_KEY"));

// Gmail read tools, authorized via the cached OAuth token (run `bun run
// authorize` first to mint token.json). The model can request these; the
// registry executes them and the loop feeds results back for summarizing.
const gmail = createGmailApi(loadAuthorizedClient());
const registry = createToolRegistry([searchEmailsTool(gmail), readEmailTool(gmail)]);
const agent = createAgentLoop(provider, registry);

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
    (text) => say({ text, thread_ts: event.thread_ts ?? event.ts }),
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
    (text) => say(text),
    (text) => agent.respond(threadKey, text),
  );
});

await app.start();
console.log("⚡️ Slack assistant is running (Socket Mode)");
