// src/llm.js
// Provider-agnostic LLM client. Defaults to OpenRouter (free tier, OpenAI-
// compatible chat format) so you don't need a paid key to get started.
// Switch providers anytime via LLM_PROVIDER in .env — nothing else in the
// codebase needs to change.

const fetch = require("node-fetch");

const PROVIDER = (process.env.LLM_PROVIDER || "openrouter").toLowerCase();

const PROVIDERS = {
  openrouter: {
    url: "https://openrouter.ai/api/v1/chat/completions",
    defaultModel: "meta-llama/llama-3.3-70b-instruct:free",
    headers: (key) => ({
      "content-type": "application/json",
      authorization: `Bearer ${key}`,
      // OpenRouter asks for these two so free-tier traffic is attributable;
      // they're optional but avoid occasional throttling.
      "HTTP-Referer": "https://vera-bot.local",
      "X-Title": "vera-bot",
    }),
  },
  groq: {
    url: "https://api.groq.com/openai/v1/chat/completions",
    defaultModel: "llama-3.3-70b-versatile",
    headers: (key) => ({
      "content-type": "application/json",
      authorization: `Bearer ${key}`,
    }),
  },
  openai: {
    url: "https://api.openai.com/v1/chat/completions",
    defaultModel: "gpt-4o-mini",
    headers: (key) => ({
      "content-type": "application/json",
      authorization: `Bearer ${key}`,
    }),
  },
  anthropic: {
    // Different request/response shape — handled separately below.
    url: "https://api.anthropic.com/v1/messages",
    defaultModel: "claude-sonnet-4-6",
    headers: (key) => ({
      "content-type": "application/json",
      "x-api-key": key,
      "anthropic-version": "2023-06-01",
    }),
  },
};

function cleanJsonText(raw) {
  return raw
    .trim()
    .replace(/^```json\s*/i, "")
    .replace(/^```\s*/i, "")
    .replace(/```\s*$/i, "")
    .trim();
}

function parseJsonLoose(cleaned) {
  try {
    return JSON.parse(cleaned);
  } catch (err) {
    const match = cleaned.match(/\{[\s\S]*\}/);
    if (match) {
      try {
        return JSON.parse(match[0]);
      } catch (_) {
        /* fall through */
      }
    }
    throw new Error(`Could not parse LLM JSON output: ${cleaned.slice(0, 300)}`);
  }
}

/** Calls Claude via the native Anthropic /v1/messages API. */
async function callAnthropic({ system, user, maxTokens, apiKey, model }) {
  const res = await fetch(PROVIDERS.anthropic.url, {
    method: "POST",
    headers: PROVIDERS.anthropic.headers(apiKey),
    body: JSON.stringify({
      model,
      max_tokens: maxTokens,
      system,
      messages: [{ role: "user", content: user }],
    }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Anthropic API error ${res.status}: ${text.slice(0, 500)}`);
  }
  const data = await res.json();
  const textBlock = (data.content || []).find((b) => b.type === "text");
  return textBlock ? textBlock.text : "";
}

/** Calls any OpenAI-compatible chat/completions endpoint (OpenRouter, Groq, OpenAI itself). */
async function callOpenAICompatible({ system, user, maxTokens, apiKey, model, cfg }) {
  const res = await fetch(cfg.url, {
    method: "POST",
    headers: cfg.headers(apiKey),
    body: JSON.stringify({
      model,
      max_tokens: maxTokens,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
      // Ask nicely for JSON where the provider supports it; harmless if ignored.
      response_format: { type: "json_object" },
    }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`${PROVIDER} API error ${res.status}: ${text.slice(0, 500)}`);
  }
  const data = await res.json();
  if (data.error) {
    throw new Error(`${PROVIDER} API error: ${JSON.stringify(data.error).slice(0, 500)}`);
  }
  return data?.choices?.[0]?.message?.content || "";
}

/**
 * Calls the configured LLM and returns a PARSED JS OBJECT.
 * We instruct the model to reply with raw JSON only, then defensively
 * strip code fences / extract the first {...} blob in case it doesn't.
 */
async function callClaudeJSON({ system, user, maxTokens = 700 }) {
  const cfg = PROVIDERS[PROVIDER];
  if (!cfg) {
    throw new Error(`Unknown LLM_PROVIDER "${PROVIDER}". Use one of: ${Object.keys(PROVIDERS).join(", ")}`);
  }

  const apiKey = process.env.LLM_API_KEY || process.env.OPENROUTER_API_KEY || process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error(
      `No API key set for provider "${PROVIDER}". Set LLM_API_KEY in your .env (see .env.example).`
    );
  }
  const model = process.env.LLM_MODEL || cfg.defaultModel;

  const raw =
    PROVIDER === "anthropic"
      ? await callAnthropic({ system, user, maxTokens, apiKey, model })
      : await callOpenAICompatible({ system, user, maxTokens, apiKey, model, cfg });

  return parseJsonLoose(cleanJsonText(raw));
}

/** Wraps callClaudeJSON with a timeout so we never blow the judge's 30s budget. */
async function callClaudeJSONWithTimeout(opts, timeoutMs = 20000) {
  return Promise.race([
    callClaudeJSON(opts),
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error("LLM call timed out")), timeoutMs)
    ),
  ]);
}

module.exports = { callClaudeJSON, callClaudeJSONWithTimeout };
