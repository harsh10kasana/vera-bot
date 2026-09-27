# Vera Bot — magicpin AI Challenge submission

A Node.js/Express implementation of the `compose(category, merchant, trigger, customer?)`
message engine described in `challenge-brief.md`, exposing the 5 endpoints required by
`challenge-testing-brief.md`.

You said you only know MERN — good news: **this whole project is plain Express**.
No Python, no FastAPI. The LLM is called over plain HTTP (OpenRouter by default — free),
same as calling any other REST API from Node.

## What's in here

```
vera-bot/
├── server.js              # the 5 HTTP endpoints (this is the "app")
├── src/
│   ├── store.js            # in-memory context store (idempotent by version)
│   ├── promptBuilder.js    # turns context JSON into the prompt sent to Claude
│   ├── llm.js               # thin fetch() wrapper around Claude's API, JSON-mode
│   ├── composer.js          # ties prompt + LLM + validation together, with fallback
│   ├── validate.js          # catches empty/repeated/taboo-word messages before sending
│   └── replyLogic.js        # deterministic auto-reply / intent / hostility handling
├── package.json
└── .env.example
```

## 1. Install & configure (5 minutes)

```bash
cd vera-bot
npm install
cp .env.example .env
```

**Get a free API key (no credit card):**
1. Go to https://openrouter.ai and sign in with Google/GitHub.
2. Go to https://openrouter.ai/keys → "Create Key" → copy it (starts with `sk-or-v1-...`).
3. Open `.env` and paste it as `LLM_API_KEY`. Leave `LLM_PROVIDER=openrouter` as is.
4. (Optional) Set `LLM_MODEL` to a specific free model — check
   https://openrouter.ai/models?max_price=0 for the current list (free models rotate).
   The default in the code (`meta-llama/llama-3.3-70b-instruct:free`) works out of the box.

Free-tier limits: 20 requests/minute, 50/day by default (jumps to 1,000/day the moment
you've ever added $10+ credit to your account — the `:free` models still cost $0 either way).
For local dev 50/day is plenty; before a real judged run, consider adding credit once just
to raise the daily cap, or switch `LLM_PROVIDER=groq` (also free, get a key at
https://console.groq.com/keys, 30 req/min / 1,000/day, no card).

Also set `TEAM_NAME` / `TEAM_MEMBERS` / `CONTACT_EMAIL` — these show up at
`GET /v1/metadata`, which the judge checks.

Want to use Claude directly instead? Set `LLM_PROVIDER=anthropic` and `LLM_API_KEY` to a key
from https://console.anthropic.com/ — same code path, just swaps the request format.

## 2. Run it locally

```bash
npm start
```

You should see `Vera bot listening on port 8080`. Quick manual check:

```bash
curl http://localhost:8080/v1/healthz
curl http://localhost:8080/v1/metadata
```

## 3. Push some real context and try a tick

The challenge zip's `dataset/` folder has sample merchants/triggers/categories.
Example of pushing one merchant + category + trigger and asking the bot to compose:

```bash
curl -X POST localhost:8080/v1/context -H "Content-Type: application/json" -d '{
  "scope": "category", "context_id": "dentists", "version": 1,
  "payload": { "slug": "dentists", "voice": {"tone":"peer_clinical","taboos":["cure","guaranteed"]}, "offer_catalog": [] },
  "delivered_at": "2026-04-29T10:00:00Z"
}'

curl -X POST localhost:8080/v1/context -H "Content-Type: application/json" -d '{
  "scope": "merchant", "context_id": "m_001_drmeera", "version": 1,
  "payload": { "merchant_id": "m_001_drmeera", "category_slug": "dentists",
               "identity": {"name": "Dr. Meera'\''s Dental Clinic", "languages":["en","hi"]},
               "performance": {"ctr": 0.021}, "offers": [], "conversation_history": [] },
  "delivered_at": "2026-04-29T10:00:00Z"
}'

curl -X POST localhost:8080/v1/context -H "Content-Type: application/json" -d '{
  "scope": "trigger", "context_id": "trg_001", "version": 1,
  "payload": { "id": "trg_001", "scope": "merchant", "kind": "research_digest",
               "merchant_id": "m_001_drmeera", "suppression_key": "research:dentists:2026-W17" },
  "delivered_at": "2026-04-29T10:00:00Z"
}'

curl -X POST localhost:8080/v1/tick -H "Content-Type: application/json" -d '{
  "now": "2026-04-29T10:30:00Z", "available_triggers": ["trg_001"]
}'
```

You'll get back an `actions[]` array with a composed `body`, `cta`, `suppression_key`
and `rationale` — that's Vera's proactive message.

For the full 50-merchant / 200-customer / 100-trigger dataset, run the challenge's
own generator first, then write a small script that loops the JSON files and POSTs
each one to `/v1/context` (a `for` loop over `fs.readdirSync` + `fetch` is enough —
happy to write that loader script for you if you want it).

```bash
python3 dataset/generate_dataset.py --seed-dir dataset --out expanded
```

## 4. Run the official Judge Simulator against it

The zip includes `judge_simulator.py`. Open it and set (near the top):

```python
BOT_URL = "http://localhost:8080"
LLM_PROVIDER = "openrouter"       # the simulator's own judge-LLM, separate from your bot's key
LLM_API_KEY = "sk-or-v1-..."      # can be the same OpenRouter key or a different one
```

Then:

```bash
python judge_simulator.py
```

It will hit your 5 endpoints with the 30 canonical test pairs and print a scored
dry run. Iterate on `src/promptBuilder.js` (the system prompt / rubric text) until
scores look good — that file is the one place you'll spend most of your time.

## 5. How the pieces map to the rubric

| Rubric dimension | Where it's handled |
|---|---|
| Decision quality | `promptBuilder.js` system prompt instructs "pick ONE signal"; `server.js` `/v1/tick` only fires one action per (merchant, trigger) |
| Specificity | Full merchant/category JSON is passed verbatim to the LLM; system prompt forbids inventing facts |
| Category fit | `category.voice` (tone + taboos) is always included in the prompt; `validate.js` hard-blocks taboo words |
| Merchant fit | Full `merchant` object (performance, offers, conversation_history, signals) is in every prompt |
| Engagement compulsion | System prompt explicitly asks for one CTA in the last sentence, and nudges toward the underused "social proof" / "ask the merchant" levers |
| Anti-repetition | `store.js` tracks `sentBodies` per conversation; `validate.js` rejects verbatim repeats |
| Auto-reply detection | `replyLogic.js` `isRepeatedAutoReply()` — same short message 3× → `action: end` |
| Intent-transition | `promptBuilder.js` reply prompt explicitly forces `action: send` + no more qualifying questions when agreement language is detected |
| Hostile/off-topic | `replyLogic.js` deterministic override stays polite, declines, redirects |
| Operational (timeouts, malformed JSON, empty body) | `llm.js` has a 20s timeout (under the judge's 30s budget); `composer.js` retries once then falls back to a safe, non-hallucinated template; `validate.js` blocks empty bodies |

## 6. Deploy so you have a public URL

Easiest free option for a MERN dev: **Render**.

1. Push this folder to a GitHub repo.
2. Go to https://render.com → New → Web Service → connect the repo.
3. Build command: `npm install`. Start command: `npm start`.
4. Add environment variables from your `.env` (Render → Environment tab):
   `LLM_PROVIDER`, `LLM_API_KEY`, `LLM_MODEL`, `TEAM_NAME`, `TEAM_MEMBERS`, `CONTACT_EMAIL`.
5. Deploy. You'll get a URL like `https://vera-bot-xxxx.onrender.com`.
6. Sanity check: `curl https://vera-bot-xxxx.onrender.com/v1/healthz`.

(Railway or Fly.io work the same way if you prefer those.)

## 7. Submit

Set `BOT_URL` in `judge_simulator.py` to your deployed URL and re-run it once
against the live deployment (not just localhost) to make sure nothing broke in
deploy (env vars are the #1 cause). Then submit the public base URL
(e.g. `https://vera-bot-xxxx.onrender.com`) via the challenge's submission portal,
plus this repo link as your README/approach writeup.

## Notes / things worth improving next

- `validate.js` does simple keyword/regex checks — you could add an actual
  language-detection check (merchant `languages` vs. detected reply language).
- Context is wiped on `POST /v1/teardown`, per the testing brief §11. In-memory
  storage is fine for a 60-minute test window; don't reach for MongoDB here,
  it adds latency you don't need under the 30s budget.
