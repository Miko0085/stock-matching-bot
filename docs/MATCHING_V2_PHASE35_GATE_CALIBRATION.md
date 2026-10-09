# Nika Matching V2 — Phase 3.5: Emergency Cost-Reduction Gate Calibration

**Status:** offline analysis only, against already-collected production shadow data. Zero new AI calls made. No production/runtime/config change was performed as part of this analysis itself — its conclusion (adopt `buyer_signal_policy = REQUIRE_ANY` as a temporary emergency measure) is implemented separately in Phase 4 (`docs/MATCHING_V2_PHASE4_GATE_CUTOVER.md`), gated behind an explicit, reversible setting.

**This document contains aggregate statistics and category counts only — no raw message text.** The manual review that informed it read real message content from `matching.shadow_gate_evaluations`/`matching.match_runs`, but those specific reviewed examples were intentionally written to a local, uncommitted scratch file (`scratchpad/phase35-review-samples.md`, never added to git) rather than into this document, per this task's explicit instruction ("Do not commit raw PII-heavy review data unless explicitly approved").

## 1. Dataset

5,298 total shadow rows at analysis time (production, live traffic, `2026-09-24T19:30 UTC` → `2026-09-25T07:19 UTC`, ~11h45m); 1,925 non-duplicate evaluations after excluding `old_decision = DUPLICATE`; 1,473 of those were old `SEND_TO_AI` (a fresh AI call the current system actually made).

## 2. Current strict gate (Policy A, `REQUIRE_BOTH`) — baseline numbers

| Metric | Value |
|---|---|
| Non-duplicate evaluations | 1,925 |
| Old fresh-AI calls | 1,473 |
| Policy A candidate SEND_TO_AI | 12 |
| Old SEND_TO_AI → Policy A REJECT | 1,468 (99.66%) |
| Blacklist hits (all rows) | 170 total occurrences / 51 disagreements (old system treated as legit) |

## 3. Policy A–E comparison (all rows)

| Policy | Combination rule | Candidate SEND_TO_AI | Saved (old AI → candidate REJECT) | Added (old non-AI → candidate SEND_TO_AI) | AI reduction |
|---|---|---|---|---|---|
| A (current strict) | WHITELIST AND PROPERTY_SIGNAL | 12 | 1,468 | 5 | 99.66% |
| B (permissive OR) | WHITELIST OR PROPERTY_SIGNAL | 573 | 1,078 | 132 | 73.18% |
| C (whitelist-first) | WHITELIST only | 170 | 1,315 | 5 | 89.27% |
| D (property-first) | PROPERTY_SIGNAL only | 415 | 1,231 | 132 | 83.57% |
| E (explicit-or-structure) | WHITELIST OR PROPERTY_SIGNAL | 573 | 1,078 | 132 | 73.18% |

**Note on E:** with the current rule taxonomy (WHITELIST = explicit buyer-intent phrases only, PROPERTY_SIGNAL = structural real-estate indicators only), Policy E's stated definition is computationally identical to Policy B's — this is reported plainly rather than manufacturing an artificial distinction between two policies that reduce to the same logic today.

## 4. Unique-message comparison (deduplicated by `message_text_hash`)

Repeating the same measurement restricted to one row per unique message content (avoiding broadcast/repost inflation) produced materially the same picture (1,718–1,719 unique non-duplicate messages, 1,473–1,474 unique old-SEND_TO_AI messages, reduction percentages within 0.05 points of the all-rows figures above) — the conclusions below are not an artifact of a few heavily-reposted messages dominating the count.

## 5. Manual review methodology

For the two most structurally distinct non-strict candidates (B and D — C is a subset of B's accepting logic; E is identical to B under the current taxonomy), a human-reviewable sample was pulled directly from production data and read in full:

- 50 messages Policy B would reject (neither WHITELIST nor PROPERTY_SIGNAL matched) that the old system had sent to AI.
- 50 messages Policy D would reject (no PROPERTY_SIGNAL match) that the old system had sent to AI.
- All 51 BLACKLIST disagreements (old system treated the message as legitimate; the gate would blacklist it).
- 20 messages Policy B would newly send to AI that the old system had not (the "added" set).
- A further 30-message sample of PROPERTY_SIGNAL-only matches and a 45-message sample of WHITELIST-only matches, to assess each signal's standalone precision.

Findings (aggregate, no raw text repeated here):

- **PROPERTY_SIGNAL-only matches (30/30 reviewed): 100% broker/multi-listing spam.** Real-estate structural terms (bedroom counts, sqft, floor, handover, AED price) appear just as densely in seller listings as in buyer requests — this signal alone does not discriminate direction.
- **WHITELIST-only matches (reviewed sample of 45): approximately 20–24% genuine buyer-intent messages.** The remainder was non-real-estate noise (job-scam recruitment posts, dating/hookup messages, currency/crypto trading solicitations, generic "add member" bot spam) that happens to contain generic intent words ("need," "ищу," "looking for") outside any real-estate context.
- **Policy B's reject set (neither signal, 50/50 reviewed): 49/50 unambiguous non-buyer content** (spam, bots, off-topic chat); 1 borderline case that plausibly represented a real but very indirectly-phrased renter inquiry.
- **Policy B's "added" set (20/20 reviewed): 100% broker multi-listing spam** — every added message had a PROPERTY_SIGNAL match (structural real-estate detail) but no WHITELIST match, consistent with the PROPERTY_SIGNAL-only finding above.
- **All 51 BLACKLIST disagreements: unambiguous seller/broker multi-listing advertisements** ("For Sale," "For Rent," multi-property broker dumps) that the old local-parser's `PARSED_LOCALLY` classification did not itself catch as a reject at that stage. No genuine buyer request was found among them.
- A small number of genuine buyer messages were identified specifically in the "WHITELIST present, PROPERTY_SIGNAL absent" category — short, conversational requests (a bed-space/room inquiry, a studio search with amenity preferences, a family-apartment request, a distressed-property buyer inquiry) that lack bedroom/sqft/price-format language but are still clearly real buyer intent. These are exactly the false negatives Policy A's `REQUIRE_BOTH` logic loses today.

## 6. Reading the numbers correctly: two different percentages

Two distinct, easily-conflated metrics appear in this analysis:

- **~73% of OLD AI calls would be rejected** by Policy B (1,078 saved / 1,473 old SEND_TO_AI) — this is the "how much of today's AI spend on THESE SAME messages disappears" figure.
- **~61% NET AI-bound volume reduction** — the more honest end-to-end figure once Policy B's own "added" volume is netted against its savings: `(1,473 old − 573 candidate) / 1,473 ≈ 61%`. The gap between 73% and 61% is exactly Policy B's added cost (132 messages, all reviewed as broker spam per section 5) — real messages that would newly reach AI under B but did not reach it before. Reporting only the 73% figure without this net figure would overstate the achievable savings.

## 7. Recommendation and Policy B's known limitation

**Policy B (permissive OR)** is the recommended **emergency, temporary** measure: it is the only candidate that meaningfully reduces the false-negative risk documented in section 5 (catching the short, conversational buyer messages Policy A loses) without a corresponding review finding of lost buyers in its own reject set. It is explicitly **not** a final, optimized policy — its ~132-message "added" cost is, per the manual review, spent entirely on broker spam that better BLACKLIST/PROPERTY_SIGNAL rule coverage should eventually filter out without needing the permissive OR at all. See `docs/MATCHING_V2_PHASE4_GATE_CUTOVER.md` for how this is implemented as a reversible, explicitly-labeled emergency configuration rather than a permanent code change.

## 8. Rule coverage gap (unchanged from Phase 3)

This calibration confirms, with a larger and more carefully reviewed sample, the gap first flagged in `docs/MATCHING_V2_PHASE3_SHADOW_GATE.md` §9/§11: the WHITELIST/PROPERTY_SIGNAL rule sets are a representative extract of `triage.js`'s real patterns, not a full port, and real buyer phrasing exists that neither list currently captures. No rule content was modified as part of this analysis (out of scope, and rule tuning is a business decision requiring evidence-backed review through the Phase 2 Settings UI, not something to guess at here).

## 9. Raw review data

`scratchpad/phase35-review-samples.md` (local, session scratchpad, not committed) contains the actual reviewed message text for every category in section 5, for anyone who needs to re-verify this analysis. It is intentionally excluded from version control.
