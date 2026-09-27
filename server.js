// server.js
// Vera bot — magicpin AI Challenge submission.
// Implements the 5 endpoints from challenge-testing-brief.md §2:
//   POST /v1/context   POST /v1/tick   POST /v1/reply
//   GET  /v1/healthz    GET  /v1/metadata

require("dotenv").config();
const express = require("express");
const store = require("./src/store");
const { composeTickMessage, composeReplyMessage } = require("./src/composer");
const { runDeterministicChecks } = require("./src/replyLogic");

const app = express();
app.use(express.json({ limit: "1mb" }));

const START_TIME = Date.now();
const MAX_ACTIONS_PER_TICK = 20;

// ---------------------------------------------------------------------------
// GET /v1/healthz
// ---------------------------------------------------------------------------
app.get("/v1/healthz", (req, res) => {
  res.json({
    status: "ok",
    uptime_seconds: Math.floor((Date.now() - START_TIME) / 1000),
    contexts_loaded: store.countsLoaded(),
  });
});

// ---------------------------------------------------------------------------
// GET /v1/metadata
// ---------------------------------------------------------------------------
app.get("/v1/metadata", (req, res) => {
  res.json({
    team_name: process.env.TEAM_NAME || "Team Alpha",
    team_members: (process.env.TEAM_MEMBERS || "You").split(",").map((s) => s.trim()),
    model: process.env.LLM_MODEL || `${process.env.LLM_PROVIDER || "openrouter"}:auto`,
    approach: "single-prompt composer with rubric-grounded system prompt + deterministic reply-flow guards",
    contact_email: process.env.CONTACT_EMAIL || "you@example.com",
    version: "1.0.0",
    submitted_at: new Date().toISOString(),
  });
});

// ---------------------------------------------------------------------------
// POST /v1/context
// ---------------------------------------------------------------------------
const VALID_SCOPES = ["category", "merchant", "customer", "trigger"];

app.post("/v1/context", (req, res) => {
  const { scope, context_id, version, payload } = req.body || {};

  if (!scope || !VALID_SCOPES.includes(scope)) {
    return res.status(400).json({ accepted: false, reason: "invalid_scope", details: `scope must be one of ${VALID_SCOPES.join(", ")}` });
  }
  if (!context_id || typeof version !== "number" || !payload) {
    return res.status(400).json({ accepted: false, reason: "invalid_scope", details: "context_id, version(number) and payload are required" });
  }

  const result = store.upsertContext(scope, context_id, version, payload);
  if (!result.ok) {
    if (result.reason === "stale_version") {
      return res.status(409).json({ accepted: false, reason: "stale_version", current_version: result.current_version });
    }
    return res.status(400).json({ accepted: false, reason: result.reason, details: "" });
  }

  res.json({
    accepted: true,
    ack_id: `ack_${context_id}_v${version}`,
    stored_at: new Date().toISOString(),
  });
});

// ---------------------------------------------------------------------------
// POST /v1/tick
// ---------------------------------------------------------------------------
app.post("/v1/tick", async (req, res) => {
  const { available_triggers = [] } = req.body || {};
  const actions = [];
  const seenMerchantThisTick = new Set(); // 1 action per (merchant, conversation) per tick

  for (const triggerId of available_triggers) {
    if (actions.length >= MAX_ACTIONS_PER_TICK) break;

    const trigger = store.getContext("trigger", triggerId);
    if (!trigger) continue;

    // Skip if we've already sent for this trigger's suppression key.
    if (store.isSuppressionSent(trigger.suppression_key)) continue;

    const merchantId = trigger.merchant_id;
    const merchant = merchantId ? store.getContext("merchant", merchantId) : null;
    if (!merchant) continue;

    const dedupeKey = `${merchantId}:${triggerId}`;
    if (seenMerchantThisTick.has(dedupeKey)) continue;

    const category = store.getContext("category", merchant.category_slug);
    if (!category) continue;

    const customer =
      trigger.scope === "customer" && trigger.customer_id
        ? store.getContext("customer", trigger.customer_id)
        : null;
    if (trigger.scope === "customer" && !customer) continue; // don't send without the context we need

    const conversationId = `conv_${merchantId}_${triggerId}`;
    const convo = store.getOrCreateConversation(conversationId, merchantId, trigger.customer_id || null, triggerId);

    try {
      const composed = await composeTickMessage({
        category,
        merchant,
        trigger,
        customer,
        alreadySent: [...convo.sentBodies],
      });

      convo.sentBodies.add(composed.body);
      convo.turns.push({ from: trigger.scope === "customer" ? "merchant_on_behalf" : "vera", message: composed.body, ts: new Date().toISOString() });
      store.markSuppressionSent(trigger.suppression_key);
      seenMerchantThisTick.add(dedupeKey);

      actions.push({
        conversation_id: conversationId,
        merchant_id: merchantId,
        customer_id: trigger.customer_id || null,
        send_as: trigger.scope === "customer" ? "merchant_on_behalf" : "vera",
        trigger_id: triggerId,
        template_name: `vera_${trigger.kind || "generic"}_v1`,
        template_params: [merchant?.identity?.name || "", trigger.kind || ""],
        body: composed.body,
        cta: composed.cta,
        suppression_key: trigger.suppression_key || "",
        rationale: composed.rationale,
      });
    } catch (err) {
      // Skip this trigger this tick rather than crash the whole batch.
      console.error(`[tick] compose failed for ${triggerId}:`, err.message);
    }
  }

  res.json({ actions });
});

// ---------------------------------------------------------------------------
// POST /v1/reply
// ---------------------------------------------------------------------------
app.post("/v1/reply", async (req, res) => {
  const { conversation_id, merchant_id, customer_id, from_role, message } = req.body || {};

  if (!conversation_id || !message) {
    return res.status(400).json({ action: "end", rationale: "Malformed reply payload." });
  }

  const convo = store.getOrCreateConversation(conversation_id, merchant_id, customer_id);
  convo.turns.push({ from: from_role || "merchant", message, ts: new Date().toISOString() });

  if (convo.ended) {
    return res.json({ action: "end", rationale: "Conversation already ended." });
  }

  // 1. Deterministic checks first (auto-reply hell, hostile+off-topic).
  const deterministic = runDeterministicChecks({ turns: convo.turns, latestMessage: message });
  if (deterministic) {
    if (deterministic.action === "end") convo.ended = true;
    if (deterministic.body) convo.sentBodies.add(deterministic.body);
    if (deterministic.body) convo.turns.push({ from: "vera", message: deterministic.body, ts: new Date().toISOString() });
    return res.json(deterministic);
  }

  // 2. Otherwise, ask the LLM composer, grounded in whatever context we have.
  const merchant = merchant_id ? store.getContext("merchant", merchant_id) : null;
  const category = merchant ? store.getContext("category", merchant.category_slug) : null;
  const customer = customer_id ? store.getContext("customer", customer_id) : null;
  const trigger = convo.trigger_id ? store.getContext("trigger", convo.trigger_id) : null;

  try {
    const decision = await composeReplyMessage({
      category,
      merchant,
      trigger,
      customer,
      turns: convo.turns,
      alreadySent: [...convo.sentBodies],
    });

    if (decision.action === "send" && decision.body) {
      convo.sentBodies.add(decision.body);
      convo.turns.push({ from: "vera", message: decision.body, ts: new Date().toISOString() });
      return res.json({
        action: "send",
        body: decision.body,
        cta: decision.cta || "open_ended",
        rationale: decision.rationale,
      });
    }
    if (decision.action === "end") {
      convo.ended = true;
      return res.json({ action: "end", rationale: decision.rationale });
    }
    return res.json({
      action: "wait",
      wait_seconds: decision.wait_seconds || 1800,
      rationale: decision.rationale,
    });
  } catch (err) {
    console.error("[reply] compose failed:", err.message);
    return res.json({
      action: "wait",
      wait_seconds: 900,
      rationale: "Internal composition error; backing off rather than sending something ungrounded.",
    });
  }
});

// ---------------------------------------------------------------------------
// POST /v1/teardown  (optional, per testing brief §11 — wipe state at test end)
// ---------------------------------------------------------------------------
app.post("/v1/teardown", (req, res) => {
  store.wipeAll();
  res.json({ ok: true });
});

// ---------------------------------------------------------------------------
app.get("/", (req, res) => {
  res.send("Vera bot is running. See /v1/healthz and /v1/metadata.");
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log(`Vera bot listening on port ${PORT}`);
});
