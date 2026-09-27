// src/composer.js
const { buildTickPrompt, buildReplyPrompt } = require("./promptBuilder");
const { callClaudeJSONWithTimeout } = require("./llm");
const { validateComposedBody } = require("./validate");

/**
 * Composes ONE proactive message for /v1/tick.
 * Retries once on validation failure (re-prompting is cheaper than a bad send).
 * Falls back to a minimal, fact-only template if the LLM can't be reached at all —
 * this never invents data, it only uses fields already in `merchant`/`trigger`.
 */
async function composeTickMessage({ category, merchant, trigger, customer, alreadySent }) {
  const { system, user } = buildTickPrompt({ category, merchant, trigger, customer, alreadySent });

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const extraNote =
        attempt === 0
          ? ""
          : "\n\nNOTE: your previous attempt failed validation. Make sure body is non-empty, has exactly one CTA, and does not repeat an ALREADY SENT message.";
      const result = await callClaudeJSONWithTimeout({
        system,
        user: user + extraNote,
        maxTokens: 500,
      });
      const check = validateComposedBody(result.body, { category, alreadySent });
      if (check.ok) {
        return {
          body: result.body,
          cta: result.cta || "open_ended",
          rationale: result.rationale || "Composed from category+merchant+trigger context.",
        };
      }
    } catch (err) {
      // fall through to retry / fallback
      if (attempt === 1) {
        return fallbackTickMessage({ merchant, trigger });
      }
    }
  }
  return fallbackTickMessage({ merchant, trigger });
}

function fallbackTickMessage({ merchant, trigger }) {
  const name = merchant?.identity?.name || "there";
  return {
    body: `Hi ${name}, quick update worth a look on your account — want me to send the details?`,
    cta: "open_ended",
    rationale: `Fallback template used (LLM unavailable) for trigger ${trigger?.id || "unknown"}; kept generic and honest rather than inventing specifics.`,
  };
}

/**
 * Composes the next turn for /v1/reply, AFTER replyLogic.js's deterministic
 * checks have had first refusal. Also validates + retries once.
 */
async function composeReplyMessage({ category, merchant, trigger, customer, turns, alreadySent }) {
  const { system, user } = buildReplyPrompt({ category, merchant, trigger, customer, turns, alreadySent });

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const extraNote =
        attempt === 0
          ? ""
          : "\n\nNOTE: your previous attempt failed validation. If action is 'send', body must be non-empty, single-CTA, and not a verbatim repeat.";
      const result = await callClaudeJSONWithTimeout({
        system,
        user: user + extraNote,
        maxTokens: 500,
      });

      if (result.action === "wait") {
        return {
          action: "wait",
          wait_seconds: Number.isFinite(result.wait_seconds) ? result.wait_seconds : 1800,
          rationale: result.rationale || "Backing off — other side asked for time.",
        };
      }
      if (result.action === "end") {
        return { action: "end", rationale: result.rationale || "Conversation concluded." };
      }
      // default / "send"
      const check = validateComposedBody(result.body, { category, alreadySent });
      if (check.ok) {
        return {
          action: "send",
          body: result.body,
          cta: result.cta || "open_ended",
          rationale: result.rationale || "Advanced the conversation based on the latest reply.",
        };
      }
    } catch (err) {
      if (attempt === 1) {
        return {
          action: "wait",
          wait_seconds: 900,
          rationale: "LLM composition failed twice; backing off rather than sending something ungrounded.",
        };
      }
    }
  }
  return {
    action: "wait",
    wait_seconds: 900,
    rationale: "Validation kept failing; backing off rather than sending something ungrounded.",
  };
}

module.exports = { composeTickMessage, composeReplyMessage };
