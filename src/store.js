// src/store.js
// A simple in-memory store for the 4 context scopes + conversations.
// This is intentionally NOT a database — the spec says "in-memory is fine,
// just don't restart between calls" and bots must wipe state on teardown.

const contexts = {
  category: new Map(), // context_id -> { version, payload }
  merchant: new Map(),
  customer: new Map(),
  trigger: new Map(),
};

// conversation_id -> {
//   merchant_id, customer_id,
//   turns: [{ from, message, ts }],
//   sentBodies: Set<string>,       // anti-repetition
//   lastMerchantMessages: [string] // for auto-reply detection
//   ended: boolean
// }
const conversations = new Map();

// suppression_key -> true  (so we never send the same trigger twice)
const sentSuppressionKeys = new Set();

function upsertContext(scope, contextId, version, payload) {
  const bucket = contexts[scope];
  if (!bucket) return { ok: false, reason: "invalid_scope" };

  const existing = bucket.get(contextId);
  if (existing && existing.version >= version) {
    return { ok: false, reason: "stale_version", current_version: existing.version };
  }
  bucket.set(contextId, { version, payload });
  return { ok: true };
}

function getContext(scope, contextId) {
  const bucket = contexts[scope];
  if (!bucket) return null;
  const entry = bucket.get(contextId);
  return entry ? entry.payload : null;
}

function countsLoaded() {
  return {
    category: contexts.category.size,
    merchant: contexts.merchant.size,
    customer: contexts.customer.size,
    trigger: contexts.trigger.size,
  };
}

function getOrCreateConversation(conversationId, merchantId, customerId, triggerId) {
  if (!conversations.has(conversationId)) {
    conversations.set(conversationId, {
      merchant_id: merchantId || null,
      customer_id: customerId || null,
      trigger_id: triggerId || null,
      turns: [],
      sentBodies: new Set(),
      ended: false,
    });
  } else if (triggerId && !conversations.get(conversationId).trigger_id) {
    conversations.get(conversationId).trigger_id = triggerId;
  }
  return conversations.get(conversationId);
}

function getConversation(conversationId) {
  return conversations.get(conversationId) || null;
}

function markSuppressionSent(key) {
  if (key) sentSuppressionKeys.add(key);
}

function isSuppressionSent(key) {
  return key ? sentSuppressionKeys.has(key) : false;
}

function wipeAll() {
  for (const bucket of Object.values(contexts)) bucket.clear();
  conversations.clear();
  sentSuppressionKeys.clear();
}

module.exports = {
  upsertContext,
  getContext,
  countsLoaded,
  getOrCreateConversation,
  getConversation,
  markSuppressionSent,
  isSuppressionSent,
  wipeAll,
  _raw: { contexts, conversations }, // exposed for debugging only
};
