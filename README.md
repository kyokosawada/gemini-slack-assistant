# Slack AI Personal Assistant

A Slack bot you chat with in plain English. It reasons with an LLM (Google
Gemini) and takes real actions across your **Gmail** and **Calendar** — drafting
and sending email, checking your schedule, and booking events — always asking
before it does anything irreversible.

Second bot in a sales-ops automation portfolio, alongside
[`lead-approval-bot`](https://github.com/kyokosawada/lead-approval-bot). Where
that one is a simple, deterministic approval loop, this is a conversational,
tool-using agent.

> **Status:** in development. See the [PRD (issue #1)](https://github.com/kyokosawada/gemini-slack-assistant/issues/1) for the full design.

## How it works

```
   You (Slack)  ⇄  Bot process (Node/TS, runs locally)  ⇄  Gemini (reasoning)
                          │
                          ├─ Gmail    (read/search + send)
                          └─ Calendar (read + create events)
```

- **Always-on process** built on **Slack Bolt** + **Socket Mode** — dials out to
  Slack over a persistent WebSocket, so it needs no public URL and runs from a
  laptop for free.
- **Gemini** does the reasoning. The bot exposes a set of tools; Gemini decides
  which to call, the bot runs them, and the result feeds back into the loop.
- **Send/book actions are gated** behind a Send/Confirm button in Slack — the
  agent never sends an email or books a meeting without your OK.

## Tools

- Gmail: `search_emails`, `read_email`, `send_email` *(confirm)*
- Calendar: `list_events`, `find_free_time`, `create_event` *(confirm)*

See the [PRD (issue #1)](https://github.com/kyokosawada/gemini-slack-assistant/issues/1) for permissions, setup, and architecture rationale.
