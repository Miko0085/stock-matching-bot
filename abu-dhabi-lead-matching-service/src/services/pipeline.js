'use strict';

// Abu Dhabi contour pipeline (AGENTS.md section 0; built BY ANALOGY with
// both dubai-lead-matching-service and rf-lead-matching-service). Structure
// (routing gate -> content dedup -> V2 intake gate -> AI parse with
// interpretation cache -> alias/location resolution -> deterministic
// matcher -> persistence -> Telegram) is RF's proven orchestration shape,
// not Dubai's own (heavier) pipeline.js -- Dubai's accumulated shadow-gate
// dual-running, AI-usage billing, and an event-dedup retry-safe state
// machine over many months; none of that is required for a complete,
// working matcher, and Abu Dhabi has no need to replicate it (same reasoning
// RF's own pipeline already applied). The MATCHING step itself (alias/
// location resolution, candidate query, hard filters, scoring) reuses
// Dubai's exact area/project/building field model via
// normalization/structured-request.js + matching/matcher.js, copied
// verbatim (only the schema name differs) -- Abu Dhabi's business
// semantics are identical to Dubai's, unlike RF's.
//
// Isolation (tests/unit/pipeline.test.js's own check): this file's
// require() calls must never reference dubai-lead-matching-service or
// rf-lead-matching-service directly. Every reused piece of Dubai code is
// reached through a local thin wrapper instead (gates/v2-intake-gate.js,
// repositories/config-repository.js, notifications/render.js,
// notifications/telegram-sender.js, adapters/index.js) -- those wrapper
// files may import dubai-lead-matching-service themselves, which is fine;
// only THIS file's own require() calls are inspected by that test.
const gate = require('../gates/v2-intake-gate');
const { adapt } = require('../adapters');
const { computeContentHash, computeTextOnlyHash } = require('../../../src/core/content-dedup');
const { buildStructuredRequest } = require('../normalization/structured-request');
const { matchRequest } = require('../matching/matcher');
const { buildNotificationMessages } = require('../notifications/render');

const DUPLICATE_WINDOW_HOURS = 48;

async function runWebhookPipeline({ rawPayload, provider, deps }) {
  const sourceMessageId = `${provider}:${rawPayload.chat_id}:${rawPayload.message_id}`;
  const unified = adapt(rawPayload, provider);
  const baseArgs = {
    sourceMessageId,
    provider,
    accountId: rawPayload.account_id || null,
    chatId: String(rawPayload.chat_id),
    originalText: rawPayload.text ?? null,
  };

  // 1. Source routing -- FIRST check, transport-level, independent of gate
  // cutover state. A source not routed to ABU_DHABI (DUBAI/RF/SAUDI/NONE/
  // AUTO/not catalogued/monitoring off) must never accumulate noise here.
  const routeCheck = await deps.sourceRoutingGate.lookupSourceRoute(deps.pool, {
    provider,
    accountId: baseArgs.accountId,
    chatId: baseArgs.chatId,
  });
  if (!routeCheck.eligible) {
    const run = await deps.matchRepo.insertRejectedRun(deps.pool, {
      sourceMessageId,
      provider,
      accountId: baseArgs.accountId,
      chatId: baseArgs.chatId,
      originalText: baseArgs.originalText,
      reason: `ROUTE_REJECT: ${routeCheck.reason}`,
    });
    deps.logEvent?.({ provider, source_message_id: sourceMessageId, result_status: 'REJECTED', route_reason: routeCheck.reason, match_run_id: run.id });
    return { request_id: sourceMessageId, match_run_id: run.id, status: 'REJECTED', reason: routeCheck.reason, matches: [] };
  }

  const config = await deps.configRepo.loadActiveV2Config(deps.pool);
  const cutoverEnabled = config.settings.v2_intake_cutover_enabled?.value === true;

  if (!cutoverEnabled) {
    const run = await deps.matchRepo.insertNotImplementedRun(deps.pool, {
      sourceMessageId,
      provider,
      accountId: baseArgs.accountId,
      chatId: baseArgs.chatId,
      originalText: baseArgs.originalText,
      reason: 'ABU_DHABI_MATCHER_DISABLED: v2_intake_cutover_enabled is off',
    });
    deps.logEvent?.({ provider, source_message_id: sourceMessageId, result_status: 'NOT_IMPLEMENTED', match_run_id: run.id });
    return { request_id: sourceMessageId, match_run_id: run.id, status: 'NOT_IMPLEMENTED', reason: 'ABU_DHABI_MATCHER_DISABLED', matches: [] };
  }

  // 2. Content-hash dedup -- a real re-send of the exact same text by the
  // same author within the window is a DUPLICATE, not a fresh run.
  const contentHash = computeContentHash({ text: baseArgs.originalText, authorName: unified.author_name });
  const isDuplicate = await deps.matchRepo.checkDuplicate(deps.pool, { contentHash, windowHours: DUPLICATE_WINDOW_HOURS });
  if (isDuplicate) {
    const run = await deps.matchRepo.insertMatchRun(deps.pool, {
      sourceMessageId,
      provider,
      accountId: baseArgs.accountId,
      chatId: baseArgs.chatId,
      originalText: baseArgs.originalText,
      resultStatus: 'DUPLICATE',
      reason: 'duplicate_content_within_window',
      contentHash,
      parserVersion: deps.config?.parserVersion,
      matcherVersion: deps.config?.matcherVersion,
      requesterContactUrl: unified.author_contact,
      requesterSenderId: unified.sender_id,
      requesterName: unified.author_name,
    });
    deps.logEvent?.({ provider, source_message_id: sourceMessageId, result_status: 'DUPLICATE', match_run_id: run.id });
    return { request_id: sourceMessageId, match_run_id: run.id, status: 'DUPLICATE', reason: 'duplicate_content_within_window', matches: [] };
  }

  // 3. Pattern-based intake gate (BLACKLIST/WHITELIST/PROPERTY_SIGNAL).
  const gateResult = gate.evaluateV2IntakeGate({
    message: { text: rawPayload.text },
    runtimeSettings: config.settings,
    intakeRules: config.rules,
  });

  if (gateResult.decision === 'REJECT') {
    const run = await deps.matchRepo.insertRejectedRun(deps.pool, {
      sourceMessageId,
      provider,
      accountId: baseArgs.accountId,
      chatId: baseArgs.chatId,
      originalText: baseArgs.originalText,
      reason: `GATE_REJECT: ${gateResult.reason}`,
    });
    deps.logEvent?.({ provider, source_message_id: sourceMessageId, result_status: 'REJECTED', gate_reason: gateResult.reason, match_run_id: run.id });
    return { request_id: sourceMessageId, match_run_id: run.id, status: 'REJECTED', reason: gateResult.reason, matches: [] };
  }

  // gateResult.decision === 'SEND_TO_AI' -- real matching.
  return runRealMatching({ rawPayload, unified, provider, baseArgs, contentHash, deps });
}

async function runRealMatching({ rawPayload, unified, provider, baseArgs, contentHash, deps }) {
  const sourceMessageId = baseArgs.sourceMessageId;
  const parserVersion = deps.config?.parserVersion || 'abu-dhabi-lead-matching-service-parser-v1';
  const matcherVersion = deps.config?.matcherVersion || 'abu-dhabi-lead-matching-service-v1';
  const requesterContactUrl = unified.author_contact;
  const requesterSenderId = unified.sender_id;
  const requesterName = unified.author_name;

  const persistBase = {
    sourceMessageId,
    provider,
    accountId: baseArgs.accountId,
    chatId: baseArgs.chatId,
    sourceUrl: unified.source_url,
    groupName: unified.group_name,
    originalText: baseArgs.originalText,
    contentHash,
    parserVersion,
    matcherVersion,
    requesterContactUrl,
    requesterSenderId,
    requesterName,
  };

  // 4. AI interpretation -- cache first, a real OpenAI call on a miss.
  const textHash = computeTextOnlyHash(baseArgs.originalText || '');
  let parsed;
  let interpretationSource;
  const cached = await deps.interpretationCacheRepo.findInterpretation(deps.pool, {
    textHash,
    interpreterVersion: parserVersion,
    ttlDays: deps.config?.aiCacheTtlDays ?? 14,
  });

  if (cached) {
    parsed = cached.parsed_request;
    interpretationSource = 'cache_ai';
  } else {
    const aiResult = await deps.classifyAndParse({
      originalText: baseArgs.originalText || '',
      apiKey: deps.config.openaiApiKey,
      model: deps.config.openaiModel,
    });

    if (!aiResult.ok) {
      const run = await deps.matchRepo.insertMatchRun(deps.pool, {
        ...persistBase,
        resultStatus: 'PARSER_ERROR',
        reason: `PARSER_ERROR: ${aiResult.reason}`,
        noMatchReason: 'parser_missing_fields',
      });
      deps.logEvent?.({ provider, source_message_id: sourceMessageId, result_status: 'PARSER_ERROR', match_run_id: run.id });
      return { request_id: sourceMessageId, match_run_id: run.id, status: 'PARSER_ERROR', reason: aiResult.reason, matches: [] };
    }

    parsed = aiResult.value;
    interpretationSource = 'ai';
    await deps.interpretationCacheRepo.recordInterpretation(deps.pool, {
      textHash,
      interpreterVersion: parserVersion,
      normalizedText: baseArgs.originalText || '',
      interpretationSource: 'ai',
      messageClass: parsed.message_class,
      demandOwner: parsed.demand_owner,
      promotion: parsed.promotion,
      spam: parsed.spam,
      parsedRequest: parsed,
    });
  }

  // 5. Eligibility -- the AI's own classification is a separate, more
  // nuanced check than the phrase-based gate: a message can pass BLACKLIST/
  // WHITELIST pattern matching yet still not actually be a genuine buyer
  // request sent BY the requester.
  const isEligible = parsed.message_class === 'buyer_request' && parsed.demand_owner === 'sender' && !parsed.promotion && !parsed.spam;
  if (!isEligible) {
    const run = await deps.matchRepo.insertMatchRun(deps.pool, {
      ...persistBase,
      resultStatus: 'NO_MATCH',
      parsedRequest: parsed,
      noMatchReason: 'ai_classified_not_buyer_request',
      interpretationSource,
    });
    deps.logEvent?.({ provider, source_message_id: sourceMessageId, result_status: 'NO_MATCH', match_run_id: run.id });
    return { request_id: sourceMessageId, match_run_id: run.id, status: 'NO_MATCH', reason: 'ai_classified_not_buyer_request', matches: [] };
  }

  // 6. Alias/location normalization (AGENTS.md section 8) -- resolves
  // area/project/building/property_type via Dubai's exact canonical-
  // registry-backed dictionary before the candidate query/hard filters
  // ever see them (see normalization/structured-request.js's own
  // comments for the multi-area OR-resolution and canonical-registry
  // fallback this provides).
  const aliasIndex = await deps.aliasRepo.loadAliasIndex(deps.pool);
  const { structuredRequest, resolution } = buildStructuredRequest({
    unifiedMessage: unified,
    aiValue: parsed,
    aliasIndex,
  });

  const [stockSyncedAt, activeStockCount] = await Promise.all([
    deps.stockRepo.getLatestStockSyncedAt(),
    deps.stockRepo.getActiveStockCount(),
  ]);

  // 7. Deterministic matcher (candidate query -> hard filters -> rank).
  const matchOutcome = await matchRequest({
    structuredRequest,
    resolution,
    config: deps.config,
    fetchCandidates: deps.stockRepo.fetchCandidates,
    checkLocationExists: deps.stockRepo.checkLocationExists,
    originalText: baseArgs.originalText,
  });

  if (matchOutcome.status !== 'MATCH') {
    const run = await deps.matchRepo.insertMatchRun(deps.pool, {
      ...persistBase,
      resultStatus: matchOutcome.status,
      parsedRequest: parsed,
      normalizedRequest: structuredRequest,
      stockSyncedAt,
      activeStockCount,
      candidatesCount: matchOutcome.candidatesCount,
      matchesCount: 0,
      noMatchReason: matchOutcome.noMatchReason,
      interpretationSource,
    });
    deps.logEvent?.({ provider, source_message_id: sourceMessageId, result_status: matchOutcome.status, no_match_reason: matchOutcome.noMatchReason, match_run_id: run.id });
    return { request_id: sourceMessageId, match_run_id: run.id, status: matchOutcome.status, reason: matchOutcome.noMatchReason, matches: [] };
  }

  // 8. MATCH -- persist the run, one match_results row per surviving stock
  // item (never "top 3 only" -- AGENTS.md section 6).
  const bestScore = matchOutcome.matches[0]?.score.total ?? null;
  const run = await deps.matchRepo.insertMatchRun(deps.pool, {
    ...persistBase,
    resultStatus: 'MATCH',
    parsedRequest: parsed,
    normalizedRequest: structuredRequest,
    stockSyncedAt,
    activeStockCount,
    candidatesCount: matchOutcome.candidatesCount,
    matchesCount: matchOutcome.matches.length,
    bestScore,
    interpretationSource,
  });

  const telegramEnabled = deps.config?.telegramNotificationsEnabled === true;

  for (const entry of matchOutcome.matches) {
    await deps.matchRepo.upsertMatchResult(deps.pool, {
      matchRunId: run.id,
      sourceMessageId,
      entry,
      telegramPost: telegramEnabled,
      whatsappPost: false,
    });
  }

  if (telegramEnabled) {
    const messages = buildNotificationMessages({
      requestId: sourceMessageId,
      originalText: baseArgs.originalText,
      provider,
      groupName: unified.group_name,
      sourceUrl: unified.source_url,
      requesterName,
      requesterContactUrl,
      requesterSenderId,
      maxMessageLength: deps.config.telegramMaxMessageLength,
      // Dubai's formatMatchEntry (reused as-is, see notifications/render.js)
      // reads the raw stock row fields directly -- area/building/
      // project_community/bedrooms/transaction_type + transaction-
      // semantics.js's priceFieldForStock(transaction_type) to pick
      // selling_price vs annual_rent -- so matches are passed through
      // un-remapped, same shape stock_inventory itself has.
      matches: matchOutcome.matches.map((m) => ({
        ...m.stock,
        score: m.score.total,
      })),
    });
    await deps.telegramSender.sendMatchNotification({
      botToken: deps.config.telegramBotToken,
      chatId: deps.config.telegramMatchChatId,
      messages,
    });
  }

  deps.logEvent?.({ provider, source_message_id: sourceMessageId, result_status: 'MATCH', matches_count: matchOutcome.matches.length, best_score: bestScore, match_run_id: run.id });
  return {
    request_id: sourceMessageId,
    match_run_id: run.id,
    status: 'MATCH',
    reason: null,
    matches: matchOutcome.matches.map((m) => ({ stock_id: m.stock.stock_id, score: m.score.total, rank: m.rank })),
  };
}

module.exports = { runWebhookPipeline };
