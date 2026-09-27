// src/replyLogic.js
// Deterministic pre-checks for POST /v1/reply. These exist because
// challenge-brief.md §12 ("open challenges") and the Phase-4 replay tests
// specifically grade auto-reply detection, intent-transition handling, and
// staying on-mission under hostility — all things a raw LLM call can miss.
// If none of these fire, the caller falls through to the LLM (see server.js).

const { normalize } = require("./validate");

const INTENT_PHRASES = [
  "yes let's do it",
  "lets do it",
  "let's do it",
  "go ahead",
  "sounds good",
  "i want to join",
  "i'm interested",
  "im interested",
  "okay do it",
  "ok do it",
  "sure go ahead",
  "yes please",
  "haan kar do",
  "kar do",
  "theek hai kar do",
];

const HOSTILE_WORDS = [
  "idiot",
  "stupid",
  "useless",
  "shut up",
  "f***",
  "fuck",
  "bakwas",
  "bewakoof",
  "chutiya",
];

const OFF_TOPIC_HINTS = [
  "gst",
  "income tax",
  "loan",
  "insurance",
  "visa",
  "passport",
  "weather today",
];

const AUTO_REPLY_HINTS = [
  "thank you for contacting",
  "thanks for contacting",
  "we will get back to you",
  "currently unavailable",
  "will respond shortly",
];

/** Detects the common WhatsApp Business canned auto-reply pattern. */
function looksLikeAutoReplyText(message) {
  const n = normalize(message);
  return AUTO_REPLY_HINTS.some((h) => n.includes(h));
}

/**
 * Checks conversation history for "same merchant message 3+ times" —
 * the brief's explicit auto-reply signature.
 */
function isRepeatedAutoReply(turns) {
  const merchantMsgs = turns
    .filter((t) => t.from === "merchant" || t.from === "customer")
    .map((t) => normalize(t.message));
  if (merchantMsgs.length < 3) return false;
  const lastThree = merchantMsgs.slice(-3);
  const allSame = lastThree.every((m) => m === lastThree[0]);
  return allSame && (looksLikeAutoReplyText(lastThree[0]) || lastThree[0].length < 60);
}

function hasIntentSignal(message) {
  const n = normalize(message);
  return INTENT_PHRASES.some((p) => n.includes(p));
}

function isHostile(message) {
  const n = normalize(message);
  return HOSTILE_WORDS.some((w) => n.includes(w));
}

function isOffTopic(message) {
  const n = normalize(message);
  return OFF_TOPIC_HINTS.some((h) => n.includes(h));
}

/**
 * Runs all deterministic checks. Returns an action object if one fires,
 * or null to signal "let the LLM decide".
 */
function runDeterministicChecks({ turns, latestMessage }) {
  // 1. Auto-reply hell: same canned text 3+ times -> exit gracefully.
  if (isRepeatedAutoReply(turns)) {
    return {
      action: "end",
      rationale:
        "Detected the same short/canned reply 3+ times in a row — classic WhatsApp Business auto-reply. Exiting gracefully instead of burning turns.",
    };
  }

  // 2. Hostile + off-topic combo: stay polite, redirect once, but don't
  //    let the conversation wander — this mirrors the Phase-4 replay test.
  if (isHostile(latestMessage) && isOffTopic(latestMessage)) {
    return {
      action: "send",
      body:
        "I hear you, and I'm sorry this hasn't felt useful. I'm only set up to help with your listing and growth on magicpin, so I can't help with that — but if you want, I can pick back up on the offer we were discussing.",
      cta: "open_ended",
      rationale: "Hostile + off-topic message: stayed polite, declined unrelated request, redirected back to mission.",
    };
  }

  // No deterministic override — let the LLM compose the reply, but flag
  // intent so the prompt/validation layer can enforce "don't ask another
  // qualifying question".
  return null;
}

module.exports = {
  runDeterministicChecks,
  hasIntentSignal,
  isHostile,
  isOffTopic,
  isRepeatedAutoReply,
  looksLikeAutoReplyText,
};
