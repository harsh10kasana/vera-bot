// src/promptBuilder.js
// Turns (category, merchant, trigger, customer?) into the prompt Claude sees.
// Keep this file as the place you iterate on "prompt engineering" for the
// challenge — the rubric text below is copied straight from challenge-brief.md.

const SYSTEM_PROMPT = `You are the message-composition brain behind "Vera", magicpin's
merchant-growth AI assistant. You write ONE outbound WhatsApp message at a time,
either to a merchant or (on the merchant's behalf) to a merchant's customer.

You will be scored on 5 dimensions, each 0-10:
1. Decision quality — did you pick the ONE best signal for this moment, combining
   trigger + merchant state + category fit, instead of dumping every fact you have?
2. Specificity — real numbers, offers, dates, and local facts FROM THE GIVEN INPUT ONLY.
   Never invent a stat, source, or competitor that isn't in the context you were given.
3. Category fit — tone must match the business type (e.g. dentists = clinical/peer,
   never hype; salons/restaurants can be warmer/visual; pharmacies = compliance-careful).
4. Merchant fit — personalize to this merchant's real metrics, offers, and conversation
   history. Reference what's specific to THEM, not a generic template.
5. Engagement compulsion — give ONE strong reason to reply now, with a low-effort next
   action. Prefer social proof and "ask the merchant a question" levers — these are
   underused and score well.

Hard rules (violating any of these tanks your score):
- Exactly ONE call-to-action per message, and it must land in the LAST sentence.
- Never use generic percentage-off offers ("Flat 30% off") if a service+price offer
  exists in the merchant's catalog — use "Haircut @ ₹99" style instead.
- Never use hype language ("AMAZING DEAL!!") for clinical categories (dentists, doctors).
- Never invent facts: no fake sources, no fake competitor names, no fake numbers.
  Only use what is present in the context payload you're given.
- No long preambles ("I hope you're doing well..."). Get to the point.
- Do not re-introduce yourself if conversation_history already shows prior turns.
- Match the merchant's/customer's language preference (English, or Hindi-English
  code-mix when languages/language_pref indicates "hi" or "hi-en mix").
- Never repeat, verbatim or near-verbatim, a message listed under "ALREADY SENT" below.

You must reply with RAW JSON ONLY — no markdown fences, no commentary before or after.`;

function fmt(obj) {
  return JSON.stringify(obj, null, 2);
}

/** Trims a category context down to what's relevant, so prompts stay small & fast. */
function slimCategory(category) {
  if (!category) return null;
  return {
    slug: category.slug,
    voice: category.voice,
    offer_catalog: category.offer_catalog,
    peer_stats: category.peer_stats,
    digest: (category.digest || []).slice(0, 6),
    seasonal_beats: category.seasonal_beats,
    trend_signals: category.trend_signals,
    patient_content_library: (category.patient_content_library || []).slice(0, 4),
  };
}

/**
 * Builds the prompt for a PROACTIVE send (used by POST /v1/tick).
 * Returns { system, user }.
 */
function buildTickPrompt({ category, merchant, trigger, customer, alreadySent }) {
  const scopeLine =
    trigger.scope === "customer"
      ? "This message is CUSTOMER-FACING — it will be sent from the merchant's WhatsApp number, to their customer. send_as must be 'merchant_on_behalf'."
      : "This message is MERCHANT-FACING — it goes directly to the merchant from Vera. send_as must be 'vera'.";

  const user = `${scopeLine}

CATEGORY CONTEXT:
${fmt(slimCategory(category))}

MERCHANT CONTEXT:
${fmt(merchant)}

TRIGGER (the reason to message right now):
${fmt(trigger)}

CUSTOMER CONTEXT (only present for customer-facing sends):
${customer ? fmt(customer) : "null — this is a merchant-facing message"}

ALREADY SENT in this conversation (never repeat these verbatim):
${alreadySent && alreadySent.length ? alreadySent.map((b, i) => `${i + 1}. ${b}`).join("\n") : "(none yet — this is the opener)"}

Compose the single best next WhatsApp message for this trigger.

Reply with RAW JSON matching exactly this shape:
{
  "body": "the WhatsApp message text",
  "cta": "open_ended" | "binary_yes_no" | "slot_choice",
  "rationale": "1-2 sentences: which signal you chose and why, for the judge's rationale field"
}`;

  return { system: SYSTEM_PROMPT, user };
}

/**
 * Builds the prompt for a REACTIVE turn (used by POST /v1/reply), after our
 * own deterministic checks (auto-reply / intent-transition / hostile) have
 * already had first crack at it in replyLogic.js.
 */
function buildReplyPrompt({ category, merchant, trigger, customer, turns, alreadySent }) {
  const historyText = turns
    .map((t) => `[${t.from.toUpperCase()}] ${t.message}`)
    .join("\n");

  const user = `CATEGORY CONTEXT:
${fmt(slimCategory(category))}

MERCHANT CONTEXT:
${fmt(merchant)}

TRIGGER THAT STARTED THIS CONVERSATION:
${trigger ? fmt(trigger) : "unknown / not tracked"}

CUSTOMER CONTEXT (if this is a customer-facing thread):
${customer ? fmt(customer) : "null"}

CONVERSATION SO FAR (oldest to newest):
${historyText}

ALREADY SENT by us in this conversation (never repeat verbatim):
${alreadySent && alreadySent.length ? alreadySent.map((b, i) => `${i + 1}. ${b}`).join("\n") : "(none yet)"}

Decide the next move. Three options:
- "send": you have something specific and useful to say right now.
- "wait": the other side asked for time / isn't ready — back off gracefully.
- "end": they declined, went off-topic and won't return to the mission after
  a polite redirect, or the conversation has run its course.

If the last message clearly signals AGREEMENT or explicit intent to proceed
("yes", "let's do it", "go ahead", "sounds good"), you MUST choose "send" and
move straight to action — do NOT ask another qualifying question.

Reply with RAW JSON matching exactly this shape:
{
  "action": "send" | "wait" | "end",
  "body": "message text — REQUIRED if action is 'send', omit/empty otherwise",
  "cta": "open_ended" | "binary_yes_no" | "slot_choice",
  "wait_seconds": 1800,
  "rationale": "1-2 sentences explaining the decision, for the judge"
}
Only include "wait_seconds" when action is "wait". Only include "cta" when action is "send".`;

  return { system: SYSTEM_PROMPT, user };
}

module.exports = { buildTickPrompt, buildReplyPrompt, slimCategory };
