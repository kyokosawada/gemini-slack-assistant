# PRD — Slack AI Personal Assistant

A Slack bot you chat with in plain English. It reasons with an LLM and takes
real actions across your Gmail and Calendar — drafting and sending email,
checking your schedule, and booking events — always asking before it does
anything irreversible.

This is the second bot in a sales-ops automation portfolio. The first
([`lead-approval-bot`](https://github.com/kyokosawada/lead-approval-bot)) is a
simple, deterministic approval loop. This one is deliberately more
sophisticated: a conversational, tool-using agent.

---

## Why

Built to showcase **AI-driven workflows** for a remote full-stack role. The job
asks for Slack bots, automations, and AI-driven workflows over tools like Gmail
and Calendar. This bot demonstrates all three in one cohesive piece, and pairs
thematically with the first bot (leads → approval → email; now leads → chat →
email + scheduling).

## Goals

- A working agent you talk to in Slack that completes real Gmail + Calendar tasks.
- Genuinely well-engineered: clean tool boundaries, a confirm gate on irreversible actions, real error handling.
- Free to run and free to demo.

## Non-goals

- Not a multi-tenant / publicly distributed Slack app (single workspace, single user).
- Not 24/7 hosted to start — run locally for demos; a free always-on host is an optional later step.
- No payments, e-sign, or CRM integrations in v1 (possible future work).

## Users

Just the author. Single Slack workspace ("Development"), single Google account.
This keeps Google OAuth in "Testing" mode — no verification, no cost.

---

## What it does

You DM or @mention the bot in plain English. Examples:

- *"What leads came in today?"* → searches Gmail, summarizes.
- *"Draft a follow-up to Jane at Acme."* → drafts a reply, shows it, waits for your OK.
- *"When am I free Thursday afternoon?"* → reads the calendar, lists open slots.
- *"Book a 30-min intro with Jane Thursday 2pm and tell her it's confirmed."* → creates the event and sends the email, each behind a confirm.

The bot reasons about the request, calls whatever tools it needs, and replies in
the channel. Anything that sends or books is gated behind a Send/Confirm button.

---

## Architecture

```
   You (Slack)  ⇄  Bot process (Node/TS, runs locally)  ⇄  Gemini (reasoning)
                          │
                          ├─ Gmail    (read/search + send)
                          └─ Calendar (read + create events)
```

- **Always-on process** built on **Slack Bolt** using **Socket Mode**. The bot
  dials out to Slack over a persistent WebSocket — no public URL needed, so it
  runs from a laptop for free. Bolt auto-acks Slack's 3-second window, then the
  handler keeps running in the live process to complete slow agent work.
- **Reasoning:** Google **Gemini** (free tier). The bot sends Gemini the
  conversation plus the list of available tools; Gemini either answers or
  requests a tool call.
- **The agent loop:** message in → Gemini → (tool call → run it → feed result
  back → Gemini) repeated until Gemini returns a final answer → post to Slack.
- **Tools** are plain functions the bot exposes to Gemini. Gemini never touches
  Google directly — it can only ask the bot to run a tool.
- **Confirm gate:** `send_email` and `create_event` don't execute on the
  model's say-so. The bot posts a preview to Slack with Send/Confirm buttons and
  waits for the user to click (same interactive-button pattern as bot #1).

### Why this shape (vs. bot #1)

Bot #1 is serverless (Netlify Functions), no framework, request/response — the
right call for a simple button loop. A conversational agent needs the Events
API and long-running work per message, which fits an always-on process with
Socket Mode far better and avoids the serverless 3-second-ack / async-background
problem. Using Bolt here (vs. bot #1's hand-rolled `@slack/web-api`) also shows
range: raw mechanics in one bot, idiomatic framework in the other.

---

## Tools

**Gmail**
- `search_emails(query)` — find/list emails.
- `read_email(id)` — full content of one message.
- `send_email(to, subject, body)` — **gated by confirm.**

**Calendar**
- `list_events(start, end)` — what's on the calendar.
- `find_free_time(date, duration)` — open slots.
- `create_event(title, start, duration, attendees?)` — **gated by confirm.**

---

## Permissions

### Google (OAuth scopes)
- `gmail.readonly` — read/search email.
- `calendar.events` — read and create calendar events.
- Sending email uses an SMTP **app password** (reused from bot #1), **not** an
  OAuth scope — keeps the OAuth surface small.

Setup: a Google Cloud project with the Gmail + Calendar APIs enabled; OAuth
consent screen in **Testing** mode with the author as the sole test user (no
verification, no cost).

⚠️ Known gotcha: in Testing mode the OAuth refresh token expires after ~7 days,
so re-authorize roughly weekly. Fine for a showcase — re-auth before a demo.

### Slack (its own new app, same workspace)
- Bot token scopes: `app_mentions:read`, `chat:write`, `im:history`, `im:write`.
- Socket Mode enabled → app-level token with `connections:write`.
- Event subscriptions: `app_mention`, `message.im`.

---

## Tech stack

- **Runtime:** Node.js + TypeScript (bun for tooling, per author's setup).
- **Slack:** `@slack/bolt` (Socket Mode).
- **LLM:** Google Gemini (free tier) via the official Google AI SDK.
- **Google APIs:** `googleapis` for Gmail read + Calendar.
- **Email send:** `nodemailer` + Gmail SMTP app password (reused from bot #1).
- **Hosting:** run locally for demos; optional free always-on host (e.g. Oracle
  Cloud Free Tier) later.

---

## Out of scope / future

- 24/7 hosting on a free always-on host.
- Persistent memory across restarts (v1 keeps conversation state in-process).
- Additional integrations named by the target role (Smartlead, Aimfox, e-sign, payments).
- Sending via the Gmail API instead of SMTP, for a single consistent auth flow.

---

## Open setup items

- Create the bot's own Slack app + Socket Mode app-level token.
- Create the Google Cloud project, enable APIs, configure the Testing-mode consent screen, run the OAuth flow once.
- Confirm current free always-on host options *if/when* 24/7 is wanted (free tiers shift; verify rather than assume).
