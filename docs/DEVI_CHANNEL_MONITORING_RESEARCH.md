# Devi AI — Channel Monitoring Research (for replicating functionality)

## Source and method

Everything below comes from Devi's public marketing site (`https://ddevi.com/en`,
`/en/pricing`, `/en/app`) and the list of internal links exposed on the
homepage. The actual in-app settings screens (where a logged-in user adds a
channel, picks keywords, etc.) live behind login at `mobile.ddevi.com`, which
is a client-rendered Next.js app — a plain fetch only returns the empty SPA
shell, not the rendered UI. The individual channel landing pages
(`/en/telegram`, `/en/whatsapp`) 404 on direct fetch (client-side routed,
not server-rendered), so those are marketing paths only reachable by
navigating from `/en` inside a real browser.

**What this document is**: a reconstruction of Devi's monitoring/connection
*model* from what a public visitor and pricing page reveal, plus a mapping
onto our existing system and a concrete gap list. **What it is not**: a
pixel-level UI spec of their settings screens — that would require an actual
paid account and a JS-capable browser session, which we don't have.

**Update — ground truth from the installed extension**: the user has
Devi's actual Chrome extension installed locally (`chrome-extension://
obofmdbkmindkbmdjkfdmehmddjfnhad`). Its unpacked source
(`.../Extensions/obofmdbkmindkbmdjkfdmehmddjfnhad/3.3.0_0/`) is plain
files on disk — most of it readable, not compiled to a black box — and it
answers almost everything the section above had to guess at. See
"Ground truth: how the extension actually works" below; that section
supersedes any guesses above where they conflict.

**Update — screenshots from the user's own logged-in account**: the user
is an actual paying Devi customer ("Devi logged in as, Mike") and shared
screenshots of the real Settings UI — "Keywords to Monitor" and "AI Leads
Filter" — which confirms and extends the extension-code findings with the
actual configured values. See "Ground truth: the real Settings UI" below.

## Ground truth: how the extension actually works

Read directly from `manifest.json`, `README.md` (an internal architecture
note that shipped inside the package by accident), and the small
unminified per-platform content scripts (`wa.js`, `open.js`; the large
bundles `dist/scraper-index.js` / `dist/site-index.js` are minified/
webpacked and weren't decoded further).

### It's a Manifest V3 Chrome extension, not a backend service

There is no headless bot, no server-side WhatsApp/Telegram client for the
social platforms (Telegram is conspicuously **absent** from the extension's
`content_scripts`/`host_permissions` — it's likely handled server-side by
Devi via the official Bot API, unlike everything else here). For every
other channel, monitoring literally means: **the user opens facebook.com /
web.whatsapp.com / reddit.com / etc. in their own already-logged-in Chrome,
and Devi's content script rides along in that same tab.**

- `content_scripts` matches: `*.facebook.com`, `*.x.com`, `*.linkedin.com`,
  `*.reddit.com` (shared script `assets/js/open.js`), `web.whatsapp.com`
  (`wppconnect-wa.js` + `wa.js`, injected in the page's own **MAIN world**,
  not the isolated extension sandbox), `bsky.app`, `*.quora.com`,
  `*.youtube.com`.
- `optional_host_permissions` (granted per-channel, on demand, presumably
  from a settings toggle) additionally cover Instagram, Nextdoor (4 country
  domains), X, Bluesky, Threads, `fbcdn.net`, Quora, YouTube — this is the
  actual "connect a channel" UX: enabling a channel in Devi's settings is a
  Chrome permission grant for that host, not an OAuth/API-key flow.

### WhatsApp: no separate "linked device" at all — this is the important one

`wa.js` runs in WhatsApp Web's own page context (MAIN world,
`document_start`) and talks to `window.WPP` — the object exposed by
**WPPConnect** (`@wppconnect-team/wa-js`, open source) once
`wppconnect-wa.js` (946 KB, bundled) initializes via
`window.initWAABACKEND()`. WPPConnect works by hooking WhatsApp Web's own
internal Store/React modules that are already running in that tab — it is
**not** a second protocol client like Baileys. Concretely, `wa.js` exposes:
`STATUS` (paired/connected check via `WPP.isFullReady`), `GET_GROUPS`
(`WPP.group.getAllGroups()` — id, name, participants, owner, mute state),
`GET_GROUP_CHAT` (`WPP.chat.getMessages()`, with per-author contact
resolution), `GET_ME`, and — notably — **`SEND_MESSAGE`**
(`WPP.chat.sendTextMessage()`), confirming the "1-click outreach" feature
can actually send WhatsApp messages, not just draft them.

**Why this matters for us**: our own `whatsapp-worker` uses Baileys, which
registers as a genuine second linked device on the WhatsApp account — and
that is exactly the failure mode we hit and fixed this week
(`device_removed` / `401 logged_out`, see the earlier `/channels` work).
Devi's approach never creates a second device at all; it's the same
WhatsApp Web session the human already uses, so there's no separate
device slot for WhatsApp to revoke. The tradeoff is the human must keep
that Chrome tab (or a background/kiosk Chrome instance) open and logged
in — Devi is trading "always-on headless service" for "rides on a session
a human maintains anyway." This is a legitimate, lower-risk alternative
architecture worth considering if `whatsapp-worker`'s device-removal
incidents recur.

### Unified dashboard trick: iframing the real sites, headers stripped to allow it

`networkrule.json` (a `declarativeNetRequest` ruleset) strips
`X-Frame-Options`, `Content-Security-Policy`, and `Cross-Origin-*`
response headers specifically for `sub_frame` requests to Facebook,
LinkedIn, WhatsApp Web, Reddit, Bluesky, Quora, Threads, and YouTube — and
rewrites the `origin`/`referer` request headers to match each real site.
Sites like Facebook and LinkedIn deliberately send those headers to
*prevent* being embedded in someone else's iframe (anti-clickjacking);
this ruleset exists specifically to defeat that so Devi can embed the
live, logged-in site inside its own extension UI (a side panel or options
page) rather than making the user tab-switch between their dashboard and
each platform. **This is worth flagging as a real ToS/compliance risk** —
these platforms send those headers on purpose, and deliberately stripping
them to embed the site against its own stated policy is a materially
more aggressive technique than "join a group with your own account,"
which is otherwise the common thread across every channel here. Not
something to copy without a clear-eyed risk decision.

### Everything is local-first (Dexie/IndexedDB), synced up selectively

The internal config (`README.md`) shows a Dexie IndexedDB schema (`db:
fb_analyzer_8`, version 27) with one object store per platform — `groups`,
`posts`, `comments`, `tweets`, `linkedin`, `reddit`, `nextdoor`,
`whatsapp`, `telegram`, `threads`, `quora`, `youtube`, `bluesky` — plus
`messages`/`messageComments` for the outreach flow and `aiEmployee`/
`autoNews`/`aiAssets` for their content-generation features. Everything is
captured into the browser's own local database first; this is probably
the substance behind the marketing claim "does not store, view or
transfer any social media data" — it's stored on the *user's own device*,
not necessarily uploaded wholesale to Devi's servers (only flagged
leads/matches presumably get pushed up, via the webhook/backend path).

### Ban-avoidance is a first-class, explicit config, not an afterthought

```json
"scanIntervalTimerMinutes": 120,
"scanIntervalTimerMinutesMin": 90,
"scanIntervalTimerMinutesMax": 180,
"pauseScanHour": 24,
"stopScanAfterBanHour": 72,
"totalGroups": { "total": 20, "defaultadminGroups": 5 },
"expiredMaxGroups": 3,
"totalPaginationLimit": 30,
"alternatorConfig": { "maxScan": 20, "linkedin": 12, "twitter": 10,
  "reddit": 12, "nextdoor": 10, "bluesky": 12, "telegram": 15,
  "threads": 10, "quora": 10, "youtube": 10 }
```

Scans run every ~2 hours, randomized in a 90–180 min window (not a fixed
cadence — harder to fingerprint as automation), each platform gets its own
per-cycle scan budget (the "alternator"), and if the account shows signs
of a ban it self-pauses for 24h and gives up on a channel entirely after
72h of that state. This is the direct analogue of our own
`STOCK_STALE_HOURS`/gate-tuning work, just aimed at *protecting the
monitoring account* rather than *protecting match quality* — a category of
config we don't currently have at all for `telegram-worker`/
`whatsapp-worker` (both poll/stay-connected continuously with no
randomization or self-throttling on suspected rate-limiting).

### AI processing happens behind a proxy, not with an embedded key

`openAICFConnectorBase` (a Cloudflare-fronted endpoint, redacted to
`"https://hidden.path"` in the shipped config) is what the extension calls
for AI scoring/generation — the real OpenAI key never ships inside the
extension. `sentimentScore`/`buyingScore` fields on both `posts` and
`comments` in the local schema suggest a numeric score is computed and
cached per item locally, presumably combining a cheap local heuristic
pass with an async AI call for items that clear an initial bar — the same
two-stage "cheap filter, then AI" shape as our own
`Raw Monitor Primary Lead Gate` → OpenAI parser pipeline.

### What this changes in the earlier gap analysis

The "Facebook groups is the natural next channel" recommendation still
holds, but the *mechanism* should be a content-script/extension-style
approach (a real logged-in browser tab reading the DOM/internal APIs),
not a headless Playwright bot — Facebook's bot detection is aimed
squarely at exactly that. Reddit is the one channel here with a genuine
public API and could reasonably skip the extension approach entirely.

## What Devi is

An AI-powered lead-generation / social-listening tool: it watches posts,
comments and conversations across social platforms for buying signals and
surfaces the ones that look like real intent-to-buy.

## Channels monitored (11 total)

Facebook groups (public and private), LinkedIn, Reddit, Twitter/X, Nextdoor,
Quora, YouTube, WhatsApp, Bluesky, Threads, Telegram — plus "global
newspapers" and "website blogs" as passive sources (not a connectable
channel, more like an ingested feed).

## Connection model — the key architectural point

> "No admin required to monitor" (Facebook groups); "can monitor any group
> public or private you are part of."

This is the same model our own `telegram-worker` / `whatsapp-worker` already
use: a **personal account joins the group like any member**, and the tool
reads what that account can see — no group-admin API access, no official
Business API approval needed. For LinkedIn/Twitter/Reddit, Devi says it
"automatically monitors the global posts relevant to location and/or close
network" — i.e. a feed/search-based pull rather than "join a specific
group," which doesn't apply to Telegram/WhatsApp (those are genuinely
group-membership-gated, same as ours).

**Conclusion: we already have the hard part** (a real logged-in
Telegram/WhatsApp session monitoring groups the account is a member of, via
`telegram-worker`/`whatsapp-worker`). Devi's differentiator isn't a smarter
connection mechanism — it's breadth (11 platforms vs our 2) and productized
settings UI around the same idea.

## Monitoring / filtering settings (as described, not screenshotted)

- **Keyword monitoring** — "Global and location-based keyword tracking
  across platforms." This maps directly to our `RAW_INCLUDE_ANY` /
  `RAW_EXCLUDE_ANY` legacy keyword lists and the newer `classifyIntentV2`
  signal-scoring in `Raw Monitor Primary Lead Gate`.
- **Intent detection** — "AI read posts to detect buy intent," explicitly
  also "flagging complaints and eliminating spam." This is the same job our
  AI parser + `is_request` field does (ADR-016), plus the
  seller/advertisement/non-property negative signals already in our gate.
  Devi frames it as one combined "intent" pass; we split it into a
  regex/keyword pre-filter (cheap, catches obvious junk) and an LLM parse
  (expensive, structures the real candidates) — arguably a better-designed
  split for cost control.
- **Per-group / per-channel limits, not a location whitelist** — the
  pricing page frames capacity as "25 groups" (extendable at $2/group), not
  as a fixed list of allowed neighborhoods. This is worth noting against our
  own current production gate: `Universal Filter + Normalize`'s
  `locationFilter` hardcodes only 2 allowed areas (City Walk, MJL) — see the
  earlier audit conversation. We decided to leave that as-is since it turned
  out not to gate the matching pilot's actual input path, but it's a
  structural difference from Devi's model worth remembering if that node is
  ever revisited: Devi scales monitoring capacity by "how many groups," not
  by "which specific micro-locations."

## Alerts / output

- **Webhook notifications** for leads — same mechanism as our own
  `HTTP Request - NIKA Matching Pilot` node forwarding accepted leads
  onward, and our Telegram alert delivery.
- **Unified dashboard** across all connected platforms, 24/7 automatic
  tracking — same purpose as our `dashboard/` (Node, read-only, now
  including `/channels` for worker/session status).
- Devi additionally does **outreach automation** (1-click AI-drafted
  comment/DM) and **content generation/scheduling** — these are adjacent
  product features (post-lead engagement, content marketing) outside our
  current scope (we stop at "alert the broker with a scored match").

## Pricing / capacity model (for reference, not for replication)

- Trial: $1 / 10 days.
- Base plan: 25 groups across the supported platforms, 1000 ChatGPT API
  calls included, webhook notifications, buyer-intent detection.
- Extra groups: $2 each (Facebook, WhatsApp, Reddit, Telegram).
- Annual plan: 2 months free, real human chat support, "100% Anytime Refund
  Policy."
- Data privacy claim: "does not store, view or transfer any social media
  data processed through it" (unclear if this means zero persistence or
  just no third-party sharing — can't verify without a paid account).

## Mapping table: Devi vs our system today

| Capability | Devi | Us today |
|---|---|---|
| Telegram group monitoring, personal account | Yes | Yes (`telegram-worker`) |
| WhatsApp group monitoring, personal account | Yes | Yes (`whatsapp-worker`) |
| Facebook / LinkedIn / Reddit / X / Nextdoor / Quora / YouTube / Bluesky / Threads | Yes (9 more channels) | **No** |
| Keyword + AI intent filtering | Yes (combined) | Yes, two-stage (regex gate + LLM parse) |
| Per-channel connect UI with live status | Implied (product screens) | Yes, just built (`/channels`) |
| Webhook lead delivery | Yes | Yes |
| Unified dashboard | Yes | Yes (`dashboard/`) |
| Deterministic stock matching + scoring | Not offered (Devi is lead-gen only, not inventory matching) | **Yes — this is our differentiator, not theirs** |
| Outreach draft generation (AI-written DM/comment) | Yes | No |
| Content calendar / social post scheduling | Yes | No (out of scope for a matching pilot) |

## Gap list to go from "2 channels" to "Devi-equivalent breadth"

Each of these is a genuinely separate integration (different auth model,
different API/scraping approach, different ToS risk profile) — not a
config toggle:

1. **Facebook groups** — closest in spirit to Telegram/WhatsApp (personal
   account joins a group), but Facebook's ToS and automation detection are
   far stricter than Telegram/WhatsApp; would need a Playwright/Puppeteer
   session-based worker (own login cookies) rather than an official API,
   with real ban risk to weigh before building.
2. **LinkedIn / X / Reddit** — these are "global search/feed" style per
   Devi's own description, not group-membership monitoring — closer to a
   scheduled keyword-search poller against each platform's public search
   than to our worker model. Reddit has a real public API (easiest of the
   three); X and LinkedIn's official APIs are expensive/restrictive, so a
   real implementation likely means scraping, again with ToS/ban risk.
3. **Nextdoor / Quora / YouTube / Bluesky / Threads** — lower priority
   given a Dubai real-estate audience; Bluesky has an open API (cheap to
   add if ever wanted), the others are scrape-only.
4. **Outreach draft generation** — technically simple to add (an LLM prompt
   the broker can trigger from a matched lead), independent of the channel
   work above.

## Recommendation

Given this system's actual business goal (match Dubai real-estate buyer/
renter demand from the groups Nika Estate's brokers are already in, against
Nika's own stock) — the highest-leverage next channel to add, if any, is
**Facebook groups**, since that's where a large share of Dubai real-estate
buyer/seller communities actually live, and it's the one Devi channel that
matches our existing "personal account joins the group" architecture. The
other 8 channels are lower priority for this specific use case and each
carries its own integration + compliance cost that should be scoped
separately before committing to it.

## Ground truth: the real Settings UI (from the user's own logged-in account)

Screenshots of Devi's actual "Settings" page, "Scan & Keyword Settings"
tab, sub-tabs "Keywords to Monitor" and "AI Leads Filter" (the user is a
real paying customer — "Devi logged in as, Mike").

### "Keywords to Monitor" is literally the source of our own keyword list

The configured keyword list shown — `mortgage buyer`, `cash buyer`,
`i have client`, `buyer requests`, `buyer request`, `pre-approved
mortgage`, `buyer requirement`, `client requirement`, `urgent request`,
`client looking for`, `buyer looking for`, `serious buyer`, **`urget
buyer`** (sic), `looking to buy`, `looking for villa`, `looking for
apartment`, `buyer inquiry`, `client requested`, plus a custom
`saadiyat island` — is **word-for-word identical**, typo included
(`urget` for `urgent`), to `RAW_INCLUDE_ANY` in our own `Raw Monitor
Primary Lead Gate`. Someone building our original gate copied this list
directly out of this exact settings screen.

The page also has a **"Keyword Search Strategy"** toggle — "Exact
Keyword Match" (currently selected) vs "Text Includes Keyword" — which is
the exact same choice as our `RAW_KEYWORD_SEARCH_STRATEGY: 'exact' |
'includes'` and its two matcher functions (`legacyExactKeywordMatch` /
`legacyMatches`). Confirms this part of our system isn't an
approximation of Devi's design — it's a direct port of it, UI toggle and
all, just hardcoded instead of exposed as a setting.

### "AI Leads Filter" — this is why it filters well, and it isn't the prompt

Three modes at the top: **Disabled / Manual analyze / Auto analyze**
(the account has Auto analyze selected — AI runs automatically on every
post that cleared the keyword step, same shape as our regex-gate →
OpenAI-parser pipeline).

The free-text **Prompt** box is explicitly scoped to *not* make the
relevance call:

> "Analyze the following social media posts and identify the key intents
> and user motivations expressed. Posts are written by third parties, not
> by the business below. Use it only to read jargon and ambiguous names
> in context, **never to decide whether a post is relevant.**"

Relevance is decided instead by a separate, structured **Filters** table
— named categories the AI scores independently, each with a `Key` (a
JSON field name), a `Name`, and a `Description`:

| Key | Name | Description (as configured) |
|---|---|---|
| `buyingIntent` | Buying Intent | "The author wants to buy, hire or pay for a product or service: asking for recommendations or vendors, reques[ts]…" |
| `seekInfo` | Information / Complaint | "Two cases. One, the author asks for help, advice or opinions: how-to, troubleshooting, or which approach to t[ake]…" (implies a second case, likely genuine complaints, cut off in the screenshot) |
| `promotion` | Promotion | "The author is advertising their own product, service, business, event, job opening or affiliate offer, including s[elf-promo]…" |
| `spam` | Spam | "The post has no genuine value to any reader: scams, phishing, get-rich-quick or crypto pumps, fake giveaway[s]…" |

The UI supports adding arbitrary custom filters ("+ Add Filters") beyond
these four, and the prompt/descriptions can reference template variables
`businessCategory`, `businessName`, `businessLocation` so the same
generic filter set adapts per account without a fully custom prompt.

**This is the actual answer to "why does it filter well"**: it isn't a
smarter prompt — the prompt is deliberately narrow. It's that the AI is
asked for **independent named labels** (buying intent / seeking-info-or-
complaint / promotion / spam) rather than one holistic yes/no judgment.
An LLM is generally more reliable at "does this post match description
X" repeated per category than at silently weighing multiple competing
signals into a single verdict — the structure does the work, not prompt
cleverness.

### Token cost: the category count barely matters, call volume does

Going from one boolean (`is_request`) to four named categories doesn't
meaningfully change token spend — the input (the post text) is unchanged,
and four short structured-output fields cost maybe a few dozen extra
output tokens over one. The real cost lever is **call volume**: one AI
call per post that clears the keyword pre-filter, identical in shape to
our own regex-gate → AI-parser pipeline. Devi's own pricing confirms this
is a real, deliberate constraint for them too — the base plan includes
"1000 ChatGPT API calls" and extra groups cost $2 each specifically
because more monitored groups means more posts clearing the keyword
filter means more AI calls. Their actual cost lever isn't a cheaper
classification schema, it's the **Disabled / Manual analyze / Auto
analyze** toggle — the user can turn AI classification off entirely or
require a manual trigger per batch. We have no equivalent control today:
`scripts/templates/matching-workflow.js`'s AI parser step runs
unconditionally on everything that clears `Raw Monitor Primary Lead
Gate`.

### Gap this reveals in our own AI parser schema — IMPLEMENTED (2026-09-15, ADR-017)

`is_request: boolean` (ADR-016) is a single collapsed judgment where Devi
uses four independent labels. Two concrete gaps that fall directly out of
the comparison:

1. **No explicit `promotion`/`spam` fields.** We rely on the regex gate's
   `SELLER_SIGNALS`/`AD_SIGNALS`/`NON_PROPERTY_REQUEST_PATTERNS` (blunt,
   pre-AI) and a general instruction in the AI system prompt to reject
   seller/commercial listings (ADR-014) — but nothing forces the AI to
   commit to an explicit, loggable "this was promotion" / "this was spam"
   label the way `is_request: false` alone doesn't distinguish *why*.
2. **No `seekInfo`-equivalent category at all.** A genuine "does anyone
   know a good area near the metro?" or "my agent scammed me" post is
   neither a buy/rent request nor noise to discard — Devi tracks it as
   its own labeled bucket (plausibly feeding their outreach/AI-employee
   features). Our system currently has no third bucket: anything that
   isn't a clean buy/rent extraction collapses into `is_request: false` →
   `not_a_request` → discarded, with no distinction from actual spam.

**Done**: the AI parser's JSON schema now returns explicit named fields
mirroring Devi's four (`buying_intent`, `seeking_info`, `promotion`,
`spam`) instead of the single `is_request` boolean; the system prompt was
narrowed to classification-only per Devi's own explicit instruction not
to decide relevance in free text; and `matcher.js`/`no-match-reason.js`
now derive a specific `no_match_reason` (`spam_content` /
`promotion_listing` / `seeking_info` / `not_a_request` as residual
fallback) from whichever label fired, instead of one generic reason for
every case. Full design rationale in ADR-017 (`docs/DECISIONS.md`).
Deliberately scoped out of this change: Devi's fully editable version
(DB-backed prompt/filter-table/mode settings edited through a UI without
a redeploy) — see ADR-017 for why that was deferred.

## Token cost estimate: scaling to 2000 monitored groups

The multi-category schema itself is not the cost driver — an AI call
costs roughly the same whether it returns one boolean or four labeled
fields (the input is the same short post text either way; four short
output fields cost maybe a few dozen extra tokens over one). The real
cost lever is **call volume**: one AI call per post that clears the free
keyword pre-filter, in both Devi's architecture and ours.

Calibrated against our own real traffic: 181 monitored Telegram dialogs
produced ~12,862 raw messages over 24h (see the earlier gate/filter
audit), of which roughly 100–150/day actually looked like genuine
buy/rent demand once past the keyword gate — about **0.83 AI calls per
group per day**. Cross-checked against Devi's own stated limit ("1000
ChatGPT API calls included" per 25-group base plan) — that implies
**~1.3 calls per group per day** on their side. The two independent
estimates land in the same order of magnitude, so a 0.83–1.3 range is a
reasonable planning band.

At 2000 groups, using our own parser's actual prompt (`gpt-4o-mini-2024-
07-18`, configured in `.env`) at roughly 470 tokens/call (≈170 system
prompt + ≈150–250 post text + ≈100 JSON output):

| | Low (0.83 calls/group/day) | High (1.3 calls/group/day) |
|---|---|---|
| AI calls/day | ~1,660 | ~2,600 |
| AI calls/month | ~49,800 | ~78,000 |
| Tokens/month | ~23.4M | ~36.7M |
| Cost/month* | ~$5.8 | ~$9.0 |

\* gpt-4o-mini pricing used: $0.15/1M input, $0.60/1M output tokens —
these are the prices known at the time of writing and should be
re-verified before using this for real budgeting.

**Conclusion**: the AI parsing cost of monitoring 2000 groups is
negligible (single-digit dollars/month) because the free keyword
pre-filter discards ~99% of raw traffic before anything reaches the LLM.
The real cost of scaling to 2000 groups is not tokens — it's the
monitoring **infrastructure**: 2000 groups' worth of Telegram/WhatsApp
accounts (or a Facebook-extension-style approach per the sections above),
each needing the same ban-avoidance discipline Devi's config shows
(randomized cadence, per-platform scan caps, self-throttling on failure)
that our own workers didn't have until the change described next.

## Throttling implemented in `whatsapp-worker` (2026-09-15)

Directly applying the lesson from Devi's `pauseScanHour`/
`stopScanAfterBanHour`/randomized-interval config: `whatsapp-worker`'s
reconnect logic used to retry every transient disconnect or error after a
**fixed** 3s/5s delay, forever, with no cap and no signal that anything
was wrong — a fixed, repeating reconnect cadence is exactly the kind of
pattern that makes an account look automated, and it was retrying blindly
even during a prolonged, structural failure.

Changed in `whatsapp-worker/server.js`:

- **Exponential backoff with jitter** (`computeBackoffDelayMs`): delay
  doubles per consecutive failure, capped at `WA_RECONNECT_MAX_DELAY_MS`
  (default 5 min), with ±20% random jitter so the retry cadence is never
  a fixed, fingerprintable interval — same spirit as Devi's randomized
  90–180 min scan window, just tuned to WhatsApp's own reconnect
  timescale (seconds/minutes) rather than a multi-hour scan cycle.
- **Escalation signal**: once `consecutiveFailures` reaches
  `WA_RECONNECT_PAUSE_AFTER_FAILURES` (default 5), the account is marked
  `throttled` in its public status — visible on the dashboard's
  `/channels` page as "(backing off)" next to the failure count.
- **Give-up threshold**: if the failure streak runs longer than
  `WA_RECONNECT_GIVE_UP_AFTER_MS` (default 2h) without a single stable
  connection, auto-retry stops entirely and the account moves to a new
  `requires_attention` status — mirroring how a real `requires_auth`
  logout already stopped auto-retry, but for a different cause (a
  structural failure, not a WhatsApp-side logout, so the session files
  are still valid and a plain retry — not a session wipe — is the right
  next step). Surfaced on `/channels` as "Reset backoff & retry now".
- **Manual reconnect resets the streak**: `connectAccount(accountId, {
  isManual: true })` — only ever called from the HTTP route, never from
  an internal scheduled retry — clears `consecutiveFailures`/
  `firstFailureAt` and cancels any pending scheduled retry, so a human
  explicitly asking to reconnect always gets a fresh attempt rather than
  inheriting whatever backoff state was in progress.
- A stable connection (`connection === 'open'`) resets the whole streak,
  so an unrelated future outage starts backoff from zero rather than
  picking up where an old, resolved outage left off.

Configurable via `WA_RECONNECT_BASE_DELAY_MS`, `WA_RECONNECT_MAX_DELAY_MS`,
`WA_RECONNECT_PAUSE_AFTER_FAILURES`, `WA_RECONNECT_GIVE_UP_AFTER_MS` (see
`whatsapp-worker/.env.example`). `telegram-worker` has no equivalent
change yet — its persistent-client model (Telethon/Pyrogram-style,
receiving live updates rather than repeatedly polling/scraping a page)
is architecturally different from both Baileys and Devi's page-scraping
extension, so the same backoff shape may not directly apply; worth a
separate look if `telegram-worker` ever shows a comparable failure
pattern.
