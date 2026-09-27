# Vera Bot — magicpin AI Challenge

A message-composition bot for magicpin's Vera assistant. Built with Express (Node.js) +
an LLM (OpenRouter / Groq / OpenAI / Anthropic — configurable). Implements the 5 endpoints
required by the challenge: `POST /v1/context`, `POST /v1/tick`, `POST /v1/reply`,
`GET /v1/healthz`, `GET /v1/metadata`.

**Live URL:** https://YOUR-RENDER-URL.onrender.com

## How it works

1. The judge pushes merchant/category/customer/trigger data via `POST /v1/context`.
2. Every 5 minutes, `POST /v1/tick` asks the bot which messages to send next. The bot
   picks the single best trigger per merchant, builds a prompt from that merchant's
   real context, and asks the LLM to compose one grounded WhatsApp message.
3. When someone replies, `POST /v1/reply` decides whether to send a follow-up, wait,
   or end the conversation — with deterministic checks for auto-reply loops, clear
   "yes let's do it" intent, and hostile/off-topic messages, backed by the LLM for
   everything else.

## Run it locally

```bash
npm install
cp .env.example .env      # add your LLM_API_KEY
npm start
```

Then: `curl localhost:8080/v1/healthz`

## Approach & tradeoffs

- **Single-prompt composer** grounded in the full category + merchant + trigger JSON,
  with a rubric-based system prompt (one CTA, no invented facts, category-appropriate
  tone) rather than a multi-step agent — keeps it fast and inside the 30s timeout.
- **Deterministic guardrails** on top of the LLM for the things that must never fail:
  no verbatim repeats, no taboo words, no empty messages, and graceful fallback to a
  safe generic message if the LLM call fails or times out.
- **In-memory context store** — fine for a 60-minute test window, wiped on teardown.

## Tech

Node.js, Express, no database. LLM calls go through `src/llm.js`, which supports
OpenRouter, Groq, OpenAI, or Anthropic via the `LLM_PROVIDER` env var.