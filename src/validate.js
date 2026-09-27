// src/validate.js
// Cheap, deterministic checks run AFTER the LLM responds. These catch the
// failure modes the judge explicitly penalizes (see challenge-testing-brief.md
// §10) before we ever send a malformed/empty/repeated message.

function normalize(s) {
  return (s || "").trim().toLowerCase().replace(/\s+/g, " ");
}

/**
 * @returns {{ ok: boolean, reason?: string }}
 */
function validateComposedBody(body, { category, alreadySent = [] } = {}) {
  if (!body || typeof body !== "string" || body.trim().length === 0) {
    return { ok: false, reason: "empty_body" };
  }

  const norm = normalize(body);

  // Anti-repetition: never send the exact same body twice in one conversation.
  for (const prev of alreadySent) {
    if (normalize(prev) === norm) {
      return { ok: false, reason: "verbatim_repeat" };
    }
  }

  // Taboo vocabulary from the category's voice profile (e.g. "cure", "guaranteed").
  const taboos = category?.voice?.taboos || [];
  for (const word of taboos) {
    if (word && norm.includes(String(word).toLowerCase())) {
      return { ok: false, reason: `taboo_word:${word}` };
    }
  }

  // Multiple-CTA smell test: more than one "Reply X for Y" style clause.
  const replyMatches = body.match(/reply\s+\d|reply\s+yes|reply\s+no/gi) || [];
  if (replyMatches.length > 1) {
    return { ok: false, reason: "multiple_ctas" };
  }

  return { ok: true };
}

module.exports = { validateComposedBody, normalize };
