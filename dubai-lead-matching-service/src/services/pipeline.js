'use strict';

const { toUnifiedRawMessage: telegramToUnified } = require('../adapters/telegram-adapter');
const { toUnifiedRawMessage: whatsappToUnified } = require('../adapters/whatsapp-adapter');
const { computeDedupKey } = require('../gates/dedup');
const { computeEventKey } = require('../gates/event-dedup');
const { lookupSourceRoute } = require('../gates/source-routing');
const { evaluateTriage, needsLocationAmbiguityEscalation } = require('../gates/triage');
const { parseAiOutput } = require('../parser/schema');
const { buildStructuredRequest } = require('../normalization/structured-request');
const { matchRequest } = require('../matching/matcher');
const { buildMatchDiagnostics } = require('../matching/diagnostics');
const { deriveSourcePostLinks } = require('../../../src/core/source-links');
const { computeTextOnlyHash, normalizeForDedup } = require('../../../src/core/content-dedup');
const { buildNotificationMessages, buildQualifiedNoMatchMessage, buildNeedsCriteriaMessage } = require('../notifications/render');
const { sendMatchNotification } = require('../notifications/telegram-sender');
const { notifyMatchedBrokers } = require('../notifications/broker-notifier');

const ADAPTERS = { telegram: telegramToUnified, whatsapp: whatsappToUnified };

// Synthesizes a schema.js-shaped value for a deterministic REJECT decision
// (no AI, no local parse) -- lets every downstream stage (eligibility
// check, interpretation cache write, StructuredRequest) treat a triage
// REJECT exactly like any other classification result instead of needing
// a separate code path.
function buildRejectValue({ messageClass, demandOwner, promotion, spam }) {
  const { value } = parseAiOutput({ message_class: messageClass, demand_owner: demandOwner, promotion, spam });
  return value;
}

// Maps a deterministic REJECT reason (triage.js) onto the message_class/
// demand_owner/promotion/spam quad, purely so it can be cached and
// persisted through the same uniform shape as an AI or local result.
function classifyRejectReason(reason) {
  if (reason === 'broker_solicitation') {
    return { messageClass: 'broker_solicitation', demandOwner: 'recipient', promotion: true, spam: false };
  }
  if (reason === 'multi_listing_inventory_ad' || reason === 'single_listing_inventory_ad') {
    return { messageClass: 'inventory_ad', demandOwner: 'unknown', promotion: true, spam: false };
  }
  // empty_text / non_property_request / anything else from the underlying
  // primary-lead-gate junk patterns.
  return { messageClass: 'other', demandOwner: 'unknown', promotion: false, spam: false };
}

// Maps the AI's classification onto one of TZ 73's rejection reasons, in a
// fixed priority order -- spam and promotion are checked before the more
// generic "not a buyer request at all" fallback so the most actionable
// diagnosis wins (same principle as the old pipeline's no-match-reason.js).
function deriveRejectionReason(aiValue) {
  if (aiValue.spam) return 'spam';
  if (aiValue.promotion || ['inventory_ad', 'general_advertisement', 'broker_solicitation'].includes(aiValue.message_class)) {
    return 'advertisement';
  }
  if (aiValue.demand_owner === 'recipient') return 'recipient_owned_demand';
  return 'not_buyer_request';
}

// TZ 26-27: matching only ever runs for a genuine, sender-owned buyer
// request. This is the fix for the Emaar/broker-solicitation regression --
// the AI is asked to label demand_owner explicitly (prompt.js) instead of
// a regex trying to infer direction from keywords.
function isEligibleForMatching(aiValue) {
  return aiValue.message_class === 'buyer_request' && aiValue.demand_owner === 'sender' && !aiValue.promotion && !aiValue.spam;
}

function buildDebugMatchesPayload(matches) {
  return matches.map((entry) => ({
    stock_id: entry.stock.stock_id,
    area: entry.stock.area,
    project_community: entry.stock.project_community,
    building: entry.stock.building,
    bedrooms: entry.stock.bedrooms,
    property_type: entry.stock.property_type,
    selling_price: entry.stock.selling_price,
    broker: entry.stock.broker,
    broker_contact: entry.stock.broker_contact,
    score: entry.score.total,
    rank: entry.rank,
  }));
}

// Shared tail: run the deterministic matcher against an already-built
// StructuredRequest, persist match_runs (+ match_results for MATCH), and
// build the API response (TZ 74: enough source metadata that a future
// Notification Router never needs to re-read the source provider).
async function runMatchAndPersist({ structuredRequest, resolution, unifiedMessage, aiParsedValue, deps, triageDecision = null, interpretationSource = null }) {
  const { config, stockRepo, matchRepo } = deps;

  // AUDIT item #2: matcher.js's capitalized-token "possible unresolved
  // project/building" safety net must only ever second-guess a LOCAL
  // interpretation. triage.js already escalates any local parse carrying
  // this ambiguity to AI_REVIEW before it can become 'local'/'cache_local'
  // here, so this backstop only fires for local parses this exact request
  // never had a chance to send to AI (e.g. a stale cache entry from before
  // this fix). An AI-derived interpretation ('ai'/'cache_ai') has already
  // had the chance to explicitly extract project/building with real
  // language understanding -- re-running the blunt heuristic against it
  // would defeat the whole point of escalating (e.g. "Cash Buyer"/
  // "Urgent"/"High Floor"/"Canal View" would wrongly re-trigger NO_MATCH
  // after AI already confirmed there is no unresolved project name).
  const isLocalInterpretation = interpretationSource === 'local' || interpretationSource === 'cache_local';

  const outcome = await matchRequest({
    structuredRequest,
    resolution,
    config,
    fetchCandidates: stockRepo.fetchCandidates,
    checkLocationExists: stockRepo.checkLocationExists,
    originalText: isLocalInterpretation ? (structuredRequest.source?.original_text ?? null) : null,
  });

  const sourceMessageId = structuredRequest.request_id;
  const provider = structuredRequest.source.provider;
  const sourceUrl = structuredRequest.source.source_url;
  const contentHash = unifiedMessage
    ? computeDedupKey(unifiedMessage)
    : null;

  const stockSyncedAt = await stockRepo.getLatestStockSyncedAt();
  const activeStockCount = await stockRepo.getActiveStockCount();

  // match_diagnostics (spec sections 20-27): only for requests that reach
  // the matcher at all -- runMatchAndPersist only runs post-eligibility,
  // so this never runs for REJECT/DUPLICATE/PARSER_ERROR. One extra
  // aggregate query when a location actually resolved (see
  // diagnostics.js's canRunFunnel gate); a lightweight, funnel-free shape
  // otherwise (INSUFFICIENT_CRITERIA / location_not_found).
  const matchDiagnostics = await buildMatchDiagnostics({
    structuredRequest,
    matchOutcome: outcome,
    activeStockCount,
    config,
    runFunnelQuery: stockRepo.fetchCandidates,
  });

  const run = await matchRepo.insertMatchRun(deps.pool, {
    sourceMessageId,
    provider,
    accountId: unifiedMessage?.account_id ?? null,
    chatId: unifiedMessage?.chat_id ?? null,
    sourceUrl,
    groupName: structuredRequest.source.group_name,
    originalText: structuredRequest.source.original_text,
    resultStatus: outcome.status,
    parsedRequest: aiParsedValue || null,
    normalizedRequest: structuredRequest,
    stockSyncedAt,
    activeStockCount,
    candidatesCount: outcome.candidatesCount,
    matchesCount: outcome.matches.length,
    bestScore: outcome.matches[0]?.score.total ?? null,
    noMatchReason: outcome.noMatchReason,
    parserVersion: config.parserVersion,
    matcherVersion: config.matcherVersion,
    contentHash,
    requesterContactUrl: structuredRequest.source.author_contact,
    requesterSenderId: unifiedMessage?.sender_id ?? null,
    requesterName: structuredRequest.source.author_name,
    triageDecision,
    interpretationSource,
    matchDiagnostics,
  });

  if (outcome.status === 'MATCH') {
    const { telegramPost, whatsappPost } = deriveSourcePostLinks(provider, sourceUrl);
    for (const entry of outcome.matches) {
      await matchRepo.upsertMatchResult(deps.pool, {
        matchRunId: run.id,
        sourceMessageId,
        entry,
        telegramPost,
        whatsappPost,
      });
    }

    // Notification Router (added on direct request, reusing the same
    // production bot/chat -- TZ 4/107 scoped this out of core v1, but a
    // persisted match with nobody to see it is not useful on its own).
    // Runs AFTER persistence succeeds, and a delivery failure never
    // fails this request -- the match is already safely recorded either
    // way (same "side effect that can't undo the main result" posture as
    // AI-usage logging).
    if (deps.config.telegramNotificationsEnabled && deps.config.telegramBotToken && deps.config.telegramMatchChatId) {
      try {
        const messages = buildNotificationMessages({
          requestId: sourceMessageId,
          originalText: structuredRequest.source.original_text,
          provider,
          groupName: structuredRequest.source.group_name,
          sourceUrl,
          requesterName: structuredRequest.source.author_name,
          requesterContactUrl: structuredRequest.source.author_contact,
          requesterSenderId: unifiedMessage?.sender_id ?? null,
          matches: outcome.matches.map((entry) => ({
            building: entry.stock.building,
            project_community: entry.stock.project_community,
            area: entry.stock.area,
            bedrooms: entry.stock.bedrooms,
            selling_price: entry.stock.selling_price,
            annual_rent: entry.stock.annual_rent,
            transaction_type: entry.stock.transaction_type,
            score: entry.score.total,
          })),
          maxMessageLength: deps.config.telegramMaxMessageLength,
        });
        await sendMatchNotification({
          botToken: deps.config.telegramBotToken,
          chatId: deps.config.telegramMatchChatId,
          messages,
        });
      } catch (err) {
        deps.logEvent?.({ level: 'error', event: 'telegram_notification_failed', request_id: sourceMessageId, error: err.message });
      }
    }

    // Broker-specific notifications (2026-10-08, direct request) -- a
    // SEPARATE, additive step from the shared-group broadcast above: tells
    // the matched stock's OWN broker, via their personally-linked Telegram
    // and/or WhatsApp. Off by default (config.brokerNotificationsEnabled);
    // its own try/catch so a failure here can never affect the broadcast
    // above or the already-persisted match_results.
    try {
      await notifyMatchedBrokers({
        pool: deps.pool,
        sourceMessageId,
        structuredRequest,
        matches: outcome.matches,
        config: deps.config,
        deps: deps.brokerNotifierDeps,
      });
    } catch (err) {
      deps.logEvent?.({ level: 'error', event: 'broker_notification_failed', request_id: sourceMessageId, error: err.message });
    }
  }

  // Qualified-buyer visibility (spec sections 34-39) -- both flags default
  // false (config/index.js); this never fires unless an operator explicitly
  // opts in. Gated on the SAME confidence bar as the MATCH notification
  // above (isEligibleForMatching already guaranteed it before
  // runMatchAndPersist was ever called) and never for REJECTED/DUPLICATE/
  // PARSER_ERROR (those return via persistNonMatchingOutcome, which never
  // reaches this function at all).
  const hasTelegramCreds = Boolean(deps.config.telegramBotToken && deps.config.telegramMatchChatId);

  if (outcome.status === 'NO_MATCH' && deps.config.telegramNotifyQualifiedNoMatch && hasTelegramCreds) {
    try {
      const message = buildQualifiedNoMatchMessage({
        requestId: sourceMessageId,
        originalText: structuredRequest.source.original_text,
        provider,
        groupName: structuredRequest.source.group_name,
        sourceUrl,
        structuredRequest,
        noMatchReason: outcome.noMatchReason,
        locationDiagnostics: outcome.locationDiagnostics,
        requesterName: structuredRequest.source.author_name,
        requesterContactUrl: structuredRequest.source.author_contact,
        requesterSenderId: unifiedMessage?.sender_id ?? null,
      });
      await sendMatchNotification({ botToken: deps.config.telegramBotToken, chatId: deps.config.telegramMatchChatId, messages: [message] });
    } catch (err) {
      deps.logEvent?.({ level: 'error', event: 'telegram_qualified_no_match_notification_failed', request_id: sourceMessageId, error: err.message });
    }
  }

  if (outcome.status === 'INSUFFICIENT_CRITERIA' && deps.config.telegramNotifyNeedsCriteria && hasTelegramCreds) {
    try {
      const message = buildNeedsCriteriaMessage({
        requestId: sourceMessageId,
        originalText: structuredRequest.source.original_text,
        provider,
        groupName: structuredRequest.source.group_name,
        sourceUrl,
        structuredRequest,
        noMatchReason: outcome.noMatchReason,
        missingRequiredFields: matchDiagnostics.request.missing_required_fields,
        requesterName: structuredRequest.source.author_name,
        requesterContactUrl: structuredRequest.source.author_contact,
        requesterSenderId: unifiedMessage?.sender_id ?? null,
      });
      await sendMatchNotification({ botToken: deps.config.telegramBotToken, chatId: deps.config.telegramMatchChatId, messages: [message] });
    } catch (err) {
      deps.logEvent?.({ level: 'error', event: 'telegram_needs_criteria_notification_failed', request_id: sourceMessageId, error: err.message });
    }
  }

  return {
    request_id: sourceMessageId,
    match_run_id: run.id,
    status: outcome.status,
    no_match_reason: outcome.noMatchReason,
    structured_request: structuredRequest,
    matches: outcome.matches.map((entry) => ({
      stock_id: entry.stock.stock_id,
      score: entry.score.total,
      rank: entry.rank,
      area: entry.stock.area,
      project_community: entry.stock.project_community,
      building: entry.stock.building,
      bedrooms: entry.stock.bedrooms,
      property_type: entry.stock.property_type,
      selling_price: entry.stock.selling_price,
      broker: entry.stock.broker,
      broker_contact: entry.stock.broker_contact,
    })),
    debug: deps.config.matchDebug
      ? { candidatesCount: outcome.candidatesCount, matches: buildDebugMatchesPayload(outcome.matches) }
      : undefined,
  };
}

async function persistNonMatchingOutcome({ status, reason, unifiedMessage, deps, triageDecision = null, interpretationSource = null }) {
  const contentHash = computeDedupKey(unifiedMessage);
  const run = await deps.matchRepo.insertMatchRun(deps.pool, {
    sourceMessageId: unifiedMessage.source_message_id,
    provider: unifiedMessage.provider,
    accountId: unifiedMessage.account_id ?? null,
    chatId: unifiedMessage.chat_id ?? null,
    sourceUrl: unifiedMessage.source_url,
    groupName: unifiedMessage.group_name,
    originalText: unifiedMessage.original_text,
    resultStatus: status,
    parsedRequest: null,
    normalizedRequest: null,
    stockSyncedAt: null,
    activeStockCount: null,
    candidatesCount: 0,
    matchesCount: 0,
    bestScore: null,
    noMatchReason: reason,
    parserVersion: deps.config.parserVersion,
    matcherVersion: deps.config.matcherVersion,
    contentHash,
    requesterContactUrl: unifiedMessage.author_contact,
    requesterSenderId: unifiedMessage.sender_id,
    requesterName: unifiedMessage.author_name,
    triageDecision,
    interpretationSource,
  });
  return {
    request_id: unifiedMessage.source_message_id,
    match_run_id: run.id,
    status,
    no_match_reason: reason,
    structured_request: null,
    matches: [],
  };
}

// Full webhook pipeline (cost-optimization plan): adapter -> event dedup ->
// content dedup -> interpretation cache -> deterministic triage
// (REJECT/PARSED_LOCALLY/AI_REVIEW, OpenAI only on AI_REVIEW) -> structured
// request -> matcher -> persistence. Every stage that can stop the
// pipeline still results in a persisted match_runs row (TZ 105) -- nothing
// is ever silently dropped. `log` accumulates one structured line per
// request (source_message_id, event_duplicate, duplicate, cache_hit,
// triage_decision, sent_to_ai, classification, ...) instead of scattering
// partial log calls across stages -- this is also the raw material the
// metrics/replay script (scripts/replay-metrics.js) aggregates into the
// cost-reduction funnel counts.
async function runWebhookPipeline({ rawPayload, provider, deps }) {
  const startedAt = Date.now();
  const log = { provider, sent_to_ai: false };
  const finish = async (result) => {
    log.duration_ms = Date.now() - startedAt;
    log.result_status = result.status;
    log.no_match_reason = result.no_match_reason;
    log.matches_count = result.matches.length;
    log.best_score = result.matches[0]?.score ?? null;
    log.request_id = result.request_id;
    deps.logEvent?.(log);

    // Nika Matching V2, Phase 3 (AGENTS_NIKA_MATCHING_V2.md section 26,
    // Phase 3, requirement 7: "The shadow evaluation may: read config,
    // compute V2 gate decision, persist shadow telemetry, emit
    // logs/metrics. Nothing else."). `finish()` is the ONE choke point
    // every exit path of this pipeline already funnels through, so it is
    // the ONE place shadow evaluation is invoked from, instead of
    // instrumenting every individual return site separately. The
    // try/catch is load-bearing (requirement 8, failure isolation): `deps`
    // objects built by existing tests never set `evaluateShadowGate`, and
    // any failure inside it (bad config load, DB insert error, unexpected
    // exception) must NEVER prevent `result` -- the real, already-decided,
    // already-persisted outcome -- from reaching the real caller.
    // Phase 4: `log.v2_skip_shadow` is set when an AUTHORITATIVE or
    // FALLBACK telemetry row was already recorded earlier in this exact
    // request (see processClaimedWebhook's cache-miss branch) -- running
    // the shadow-only old-vs-V2 comparator on top of that would produce a
    // second, misleading row for the same request (comparing the V2 gate
    // against itself, since legacy triage never ran).
    if (deps.evaluateShadowGate && !log.v2_skip_shadow) {
      try {
        await deps.evaluateShadowGate({ unifiedMessage, log, deps });
      } catch (err) {
        deps.logEvent?.({ level: 'error', event: 'shadow_gate_failed', request_id: log.request_id, error: err.message });
      }
    }

    return result;
  };

  const adapt = ADAPTERS[provider];
  const unifiedMessage = adapt(rawPayload);
  log.source_message_id = unifiedMessage.source_message_id;

  // 1. EVENT DEDUP (P0.3 release blocker) -- CLAIMS the physical webhook
  // event with a lease rather than a one-shot "seen it" flag. A claim is
  // refused only when the event is already COMPLETED (a durable business
  // outcome exists) or another attempt currently holds a live lease --
  // never for an event whose previous attempt crashed or errored, which
  // remains reclaimable (see event-dedup-repository.js). This is what
  // makes at-least-once webhook delivery + a mid-processing crash safe:
  // a failed attempt can never permanently consume a message.
  const eventKey = computeEventKey(unifiedMessage);
  const claim = await deps.eventDedupRepo.claimEvent(deps.pool, {
    eventKey,
    provider,
    accountId: unifiedMessage.account_id,
    chatId: unifiedMessage.chat_id,
    messageId: unifiedMessage.external_message_id,
  });
  log.event_duplicate = !claim.claimed;
  if (!claim.claimed) {
    return finish(await persistNonMatchingOutcome({ status: 'DUPLICATE', reason: 'duplicate_event', unifiedMessage, deps }));
  }

  try {
    const result = await processClaimedWebhook({ unifiedMessage, provider, deps, log, finish });
    await deps.eventDedupRepo.completeEvent(deps.pool, eventKey);
    return result;
  } catch (err) {
    // A genuinely unexpected failure (not one of the pipeline's own
    // handled outcomes, all of which already return normally above/below)
    // -- mark the claim retryable so the NEXT delivery of this exact
    // event (worker retry, or a manual replay) can process it, instead of
    // the event being silently and permanently lost.
    await deps.eventDedupRepo.failEvent(deps.pool, eventKey);
    throw err;
  }
}

// Calls the AI interpreter, records usage/cache, and returns either a
// resolved value or an already-finished PARSER_ERROR result to return
// immediately. Shared verbatim by the legacy AI_REVIEW branch and the
// Phase 4 authoritative SEND_TO_AI branch (AGENTS_NIKA_MATCHING_V2.md
// section 26, Phase 4, requirement 8: "reuse the existing AI interpreter
// ... do not redesign") -- byte-identical AI-calling logic either way;
// only HOW a message arrives at this point differs (local triage's
// AI_REVIEW decision vs. the V2 gate's SEND_TO_AI decision).
async function callAiInterpreter({ unifiedMessage, textHash, deps, log, triageDecision, finish }) {
  log.sent_to_ai = true;
  const aiResult = await deps.classifyAndParse({
    originalText: unifiedMessage.original_text,
    apiKey: deps.config.openaiApiKey,
    model: deps.config.openaiModel,
  });
  log.ai_model = deps.config.openaiModel;

  if (!aiResult.ok) {
    log.parser_error_reason = aiResult.reason;
    log.interpretation_source = 'ai';
    return {
      ok: false,
      result: await finish(
        await persistNonMatchingOutcome({ status: 'PARSER_ERROR', reason: aiResult.reason, unifiedMessage, deps, triageDecision, interpretationSource: 'ai' })
      ),
    };
  }

  const interpretationSource = 'ai';
  log.interpretation_source = interpretationSource;
  const resolvedValue = aiResult.value;

  if (aiResult.usage) {
    await deps.aiUsageRepo.logAiUsage(deps.pool, { sourceMessageId: unifiedMessage.source_message_id, usage: aiResult.usage });
  }

  await deps.interpretationCacheRepo.recordInterpretation(deps.pool, {
    textHash,
    interpreterVersion: deps.config.parserVersion,
    normalizedText: normalizeForDedup(unifiedMessage.original_text),
    interpretationSource: 'ai',
    messageClass: resolvedValue.message_class,
    demandOwner: resolvedValue.demand_owner,
    promotion: resolvedValue.promotion,
    spam: resolvedValue.spam,
    parsedRequest: resolvedValue,
  });

  return { ok: true, resolvedValue, interpretationSource };
}

// Runs the full classify/match/persist pipeline for an event that has
// already been claimed by runWebhookPipeline() above. Every return here
// represents a durable, persisted outcome (a match_runs row always
// exists by the time this resolves) -- only a thrown exception escapes,
// and that is exactly the P0.3 case the caller's try/catch handles.
async function processClaimedWebhook({ unifiedMessage, provider, deps, log, finish }) {
  // 1.5. Source lookup / monitoring gate (AGENTS.md section 0's required
  // shared runtime order: event idempotency [already done by the caller]
  // -> source lookup -> monitoring_enabled? -> source route). Optional
  // dependency (deps.lookupSourceRoute): a `deps` object built before this
  // gate existed treats every message as eligible, unchanged from before.
  if (deps.lookupSourceRoute) {
    const routeCheck = await deps.lookupSourceRoute(deps.pool, {
      provider: unifiedMessage.provider,
      accountId: unifiedMessage.account_id,
      chatId: unifiedMessage.chat_id,
    });
    log.source_route_eligible = routeCheck.eligible;
    log.source_route_modes = routeCheck.routeModes;
    if (!routeCheck.eligible) {
      return finish(await persistNonMatchingOutcome({ status: 'REJECTED', reason: routeCheck.reason, unifiedMessage, deps }));
    }
  }

  // 2. Existing content dedup (author + exact normalized text, time
  // window) -- unchanged purpose: prevent duplicate notifications for the
  // same buyer's request cross-posted to several groups. A DIFFERENT
  // concept from the interpretation cache below, which is content-only
  // (any author) and exists purely to avoid re-paying for AI.
  const contentHash = computeDedupKey(unifiedMessage);
  const isDuplicate = await deps.matchRepo.checkDuplicate(deps.pool, {
    contentHash,
    windowHours: deps.config.dedupWindowHours,
  });
  log.duplicate = isDuplicate;
  if (isDuplicate) {
    return finish(await persistNonMatchingOutcome({ status: 'DUPLICATE', reason: 'duplicate_content', unifiedMessage, deps }));
  }

  // 3. CONTENT INTERPRETATION CACHE -- keyed on normalized text only (no
  // author/chat/provider), so the same ad reposted by 20 different
  // brokers is recognized as identical content: the first repost may
  // trigger AI_REVIEW, every subsequent one reuses the cached result and
  // never calls OpenAI (or re-runs the deterministic triage) again.
  const textHash = computeTextOnlyHash(unifiedMessage.original_text);
  const cached = await deps.interpretationCacheRepo.findInterpretation(deps.pool, {
    textHash,
    interpreterVersion: deps.config.parserVersion,
    ttlDays: deps.config.interpretationCacheTtlDays,
  });

  let resolvedValue;
  let triageDecision = null;
  let interpretationSource;

  // A cached LOCAL interpretation is defense-in-depth checked against the
  // same ambiguity rule triage.js now applies before ever caching one --
  // guards a stale entry recorded before this fix existed. A cached AI
  // interpretation is never re-checked (AI has already made its judgment
  // call). If a stale ambiguous local entry is found, it is treated as a
  // cache miss so the request gets a fresh triage pass (and, per the fix
  // above, a real chance at AI_REVIEW) instead of silently reusing a
  // possibly-wrong local answer forever.
  const cachedValue = cached ? parseAiOutput(cached.parsed_request || {}).value : null;
  const cacheIsStaleAmbiguousLocal = Boolean(
    cached
    && cached.interpretation_source === 'local'
    && needsLocationAmbiguityEscalation(unifiedMessage.original_text, cachedValue)
  );

  if (cached && !cacheIsStaleAmbiguousLocal) {
    log.cache_hit = true;
    interpretationSource = `cache_${cached.interpretation_source}`;
    log.interpretation_source = interpretationSource;
    resolvedValue = cachedValue;
  } else {
    log.cache_hit = false;

    // Nika Matching V2, Phase 4 (AGENTS_NIKA_MATCHING_V2.md section 26,
    // Phase 4). When v2_intake_cutover_enabled is true, the deterministic
    // V2 gate -- not local triage -- decides AI eligibility. `deps.
    // evaluateAuthoritativeGate` is optional (mirrors evaluateShadowGate's
    // own convention) so every pre-Phase-4 test's `deps` object keeps
    // working unmodified; its absence is treated exactly like cutover
    // being off. ANY failure anywhere in this block (config load, gate
    // evaluation, an unrecognized policy value) is caught here and falls
    // through to the untouched legacy path below -- spec section 8: "DO
    // NOT reject the message... Fallback to legacy/current processing,"
    // never a silently-lost request.
    let usedAuthoritativeGate = false;
    if (deps.evaluateAuthoritativeGate) {
      try {
        const authResult = await deps.evaluateAuthoritativeGate({ unifiedMessage, deps });
        if (authResult.cutoverEnabled) {
          log.v2_mode = 'AUTHORITATIVE';
          log.config_version_id = authResult.configVersionId;
          log.v2_skip_shadow = true; // one telemetry row already recorded by evaluateAuthoritativeGate -- finish() must not also run the shadow-only comparator

          if (authResult.decision !== 'SEND_TO_AI') {
            interpretationSource = 'v2_gate';
            log.interpretation_source = interpretationSource;
            const rejectReason = `v2_gate_${String(authResult.reason || 'reject').toLowerCase()}`;
            return finish(
              await persistNonMatchingOutcome({ status: 'REJECTED', reason: rejectReason, unifiedMessage, deps, triageDecision: null, interpretationSource })
            );
          }
          usedAuthoritativeGate = true;
        }
      } catch (err) {
        log.v2_mode = 'FALLBACK';
        log.v2_gate_error = err.message;
        log.v2_skip_shadow = true; // a FALLBACK row is recorded below -- avoid a redundant/misleading shadow-only row on top of it
        deps.logEvent?.({ level: 'error', event: 'V2_GATE_ERROR_FALLBACK', request_id: unifiedMessage.source_message_id, error: err.message });
        if (deps.recordGateFallback) {
          try {
            await deps.recordGateFallback({ unifiedMessage, deps, error: err });
          } catch {
            // Telemetry itself failing must never break the live path either.
          }
        }
        // usedAuthoritativeGate stays false -- explicit fall-through to legacy triage below.
      }
    }

    if (usedAuthoritativeGate) {
      // V2 gate said SEND_TO_AI -- bypass local triage's own eligibility
      // decision entirely (spec section 7) and reuse the existing AI
      // interpreter unchanged (spec section 6/8).
      const aiOutcome = await callAiInterpreter({ unifiedMessage, textHash, deps, log, triageDecision: null, finish });
      if (!aiOutcome.ok) return aiOutcome.result;
      interpretationSource = aiOutcome.interpretationSource;
      resolvedValue = aiOutcome.resolvedValue;
    } else {
      // Legacy path -- cutover OFF, or cutover ON but the gate
      // infrastructure failed and we fell back. Byte-identical to every
      // pre-Phase-4 behavior: DETERMINISTIC TRIAGE -- REJECT /
      // PARSED_LOCALLY / AI_REVIEW. Only AI_REVIEW ever calls OpenAI (item
      // A.6: "OpenAI is fallback, not the default parser for every message").
      const aliasIndex = await deps.getAliasIndex();
      const triage = evaluateTriage(unifiedMessage.original_text, { aliasIndex });
      triageDecision = triage.decision;
      log.triage_decision = triageDecision;

      if (triage.decision === 'REJECT') {
        interpretationSource = 'local';
        log.interpretation_source = interpretationSource;
        const rejectClass = classifyRejectReason(triage.reason);
        resolvedValue = buildRejectValue(rejectClass);
        await deps.interpretationCacheRepo.recordInterpretation(deps.pool, {
          textHash,
          interpreterVersion: deps.config.parserVersion,
          normalizedText: normalizeForDedup(unifiedMessage.original_text),
          interpretationSource: 'local',
          messageClass: rejectClass.messageClass,
          demandOwner: rejectClass.demandOwner,
          promotion: rejectClass.promotion,
          spam: rejectClass.spam,
          parsedRequest: resolvedValue,
        });
        return finish(
          await persistNonMatchingOutcome({ status: 'REJECTED', reason: triage.reason, unifiedMessage, deps, triageDecision, interpretationSource })
        );
      }

      if (triage.decision === 'PARSED_LOCALLY') {
        interpretationSource = 'local';
        log.interpretation_source = interpretationSource;
        resolvedValue = triage.localValue;
        await deps.interpretationCacheRepo.recordInterpretation(deps.pool, {
          textHash,
          interpreterVersion: deps.config.parserVersion,
          normalizedText: normalizeForDedup(unifiedMessage.original_text),
          interpretationSource: 'local',
          messageClass: resolvedValue.message_class,
          demandOwner: resolvedValue.demand_owner,
          promotion: resolvedValue.promotion,
          spam: resolvedValue.spam,
          parsedRequest: resolvedValue,
        });
      } else {
        // AI_REVIEW -- the only branch that ever calls OpenAI.
        const aiOutcome = await callAiInterpreter({ unifiedMessage, textHash, deps, log, triageDecision, finish });
        if (!aiOutcome.ok) return aiOutcome.result;
        interpretationSource = aiOutcome.interpretationSource;
        resolvedValue = aiOutcome.resolvedValue;
      }
    }
  }

  log.classification = { message_class: resolvedValue.message_class, demand_owner: resolvedValue.demand_owner };

  // 5. Eligibility check -- uniform for every source (fresh AI, fresh
  // local parse, or any cache hit): matchable only when message_class =
  // buyer_request AND demand_owner = sender AND not promotion/spam (TZ
  // 26-27). A cache hit for a previously-REJECTED interpretation lands
  // here too and is rejected again, via the exact same rule.
  if (!isEligibleForMatching(resolvedValue)) {
    return finish(
      await persistNonMatchingOutcome({
        status: 'REJECTED',
        reason: deriveRejectionReason(resolvedValue),
        unifiedMessage,
        deps,
        triageDecision,
        interpretationSource,
      })
    );
  }

  const locationDictionary = await deps.getLocationDictionary();
  const { structuredRequest, resolution } = buildStructuredRequest({ unifiedMessage, aiValue: resolvedValue, locationDictionary });

  return finish(
    await runMatchAndPersist({ structuredRequest, resolution, unifiedMessage, aiParsedValue: resolvedValue, deps, triageDecision, interpretationSource })
  );
}

// /v1/match (TZ 31): a StructuredRequest arrives already built (from a
// test, dashboard, future Joker integration, or a manual call) --
// adapters/gate/dedup/OpenAI are skipped entirely. Alias resolution still
// runs so a caller passing a raw/unresolved name gets the exact same
// hard-filter behavior as the webhook path.
async function runStructuredRequestPipeline({ structuredRequest: input, deps }) {
  const locationDictionary = await deps.getLocationDictionary();

  // Multi-area (spec sections 10-17): accepts either `areas` (array) or the
  // legacy singular `area` -- falls back to `[area]` so an older caller
  // that only ever sends `area` gets identical behavior to before.
  const rawAreas = Array.isArray(input.areas) && input.areas.length > 0 ? input.areas : (input.area ? [input.area] : []);
  const areaOptions = rawAreas.map((raw) => locationDictionary.resolve('area', raw));
  const firstResolvedArea = areaOptions.find((option) => option.resolved);
  const legacyAreaValue = firstResolvedArea ? firstResolvedArea.canonical : (areaOptions[0] ? areaOptions[0].raw : null);

  const project = locationDictionary.resolve('project', input.project);
  const building = locationDictionary.resolve('building', input.building);
  const propertyType = locationDictionary.resolve('property_type', input.property_type);

  const structuredRequest = {
    ...input,
    area: legacyAreaValue,
    areas: areaOptions.map((option) => option.value),
    project: project.value,
    building: building.value,
    property_type: propertyType.value,
  };
  const resolution = {
    areaProvided: areaOptions.length > 0,
    areaResolved: areaOptions.some((option) => option.resolved),
    areaOptions,
    projectProvided: Boolean(input.project),
    projectResolved: project.resolved,
    buildingProvided: Boolean(input.building),
    buildingResolved: building.resolved,
    propertyTypeResolved: propertyType.resolved,
  };

  return runMatchAndPersist({ structuredRequest, resolution, unifiedMessage: null, aiParsedValue: null, deps });
}

module.exports = {
  runWebhookPipeline,
  runStructuredRequestPipeline,
  isEligibleForMatching,
  deriveRejectionReason,
};
