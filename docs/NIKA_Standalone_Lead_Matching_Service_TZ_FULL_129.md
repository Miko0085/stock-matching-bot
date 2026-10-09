# Nika Estate — Standalone Lead Matching Service
## Полное финальное техническое задание

**Статус:** Final implementation specification  
**Дата:** 2026-09-17  
**Проект:** Nika Estate / AI Broker Assistant  
**Примечание:** полная версия без сокращения структуры; 129 разделов.

---

> **ARCHITECTURE UPDATE — 2026-09-22**
>
> This document originally describes a single standalone Lead Matching Service. For all new development, the market-boundary rules in `docs/MARKET_CONTOURS_AND_SOURCE_ROUTING.md` and `AGENTS.md` are authoritative where they conflict with this document.
>
> In particular:
>
> - the current `lead-matching-service` is UAE-only;
> - RF matching is a separate independent contour/service;
> - UAE/RF stock, schemas, parsers, aliases, filters, ranking, caches and results must not be merged;
> - Telegram/WhatsApp workers remain shared transport-only components;
> - source/group discovery, monitoring enablement and UAE/RF routing move to a shared DB/UI control plane;
> - env chat/group allowlists are migration/bootstrap fallback, not the final source of truth.
>


## 1. Цель

Внутри существующего monorepo `D:\VS code\AI broker assistant` создать самостоятельный сервис, который полностью берет на себя pipeline от raw сообщения Telegram/WhatsApp до сохраненного результата matching.

```text
Telegram Worker ─────┐
                     │
WhatsApp Worker ─────┼──► Raw webhook
                     │
Future Worker ───────┘
                            ↓
                   LEAD MATCHING SERVICE
                            ↓
                  Provider Adapter
                            ↓
                  Envelope Normalization
                            ↓
                    Primary Lead Gate
                            ↓
                       Deduplication
                            ↓
                 AI Classification + Parser
                            ↓
                   Structured Request
                            ↓
                  Alias Normalization
                            ↓
                  Candidate Retrieval
                            ↓
                     Hard Filters
                            ↓
                    Valid Matches
                            ↓
                       Ranking
                            ↓
                     Persistence
                            ↓
                      Match Result
```

Notification delivery является отдельным слоем. В первой версии core сервиса notification transport не должен быть связан с matching core, но требования к будущему Telegram Notification Router зафиксированы в этом ТЗ.

---

## 2. Главный архитектурный принцип

Workers должны быть transport-only компонентами.

Telegram Worker:
```text
Telethon
→ получить NewMessage
→ собрать raw payload
→ POST webhook в Lead Matching Service
```

WhatsApp Worker:
```text
Baileys
→ получить message
→ определить корректный sender identity / LID
→ собрать raw payload
→ POST webhook в Lead Matching Service
```

Workers не должны содержать lead classification, buyer detection, regex business logic, OpenAI, property parsing, stock querying, matching, scoring, PostgreSQL match persistence, broker routing или notifications.

---

## 3. Что переносится из n8n в новый сервис

Из текущего production matching lane необходимо воспроизвести внутри standalone service:

```text
Raw Telegram/WhatsApp -> DEVI Envelope
Raw Monitor Primary Lead Gate
content hash / dedup
OpenAI Structured Parser
Validate Parser Result
aliases loading
stock loading
deterministic matching
match_runs persistence
match_results persistence
AI usage persistence
```

Известные ошибки текущей реализации не копировать, а исправить.

---

## 4. Что НЕ входит в core Lead Matching Service v1

Не включать непосредственно в matching core:

```text
Telegram transport delivery
WhatsApp transport delivery
Google Sheets Match Log
broker personal routing
broker_notification_routes execution
notification_deliveries transport execution
Joker object synchronization
Joker broker routing
dashboard UI
channel health UI
QR/reconnect management
Telegram bot management
```

Будущий Notification Router использует сохраненные MatchResult + исходные данные запроса, но остается отдельным слоем.

---

## 5. Существующий production нельзя сломать

На время разработки текущий production path продолжает работать:

```text
CURRENT PRODUCTION
workers
→ n8n
→ current matcher
→ Telegram
```

Новый сервис создается параллельно:

```text
NEW SERVICE
fixture / test / shadow request
→ Lead Matching Service
→ PostgreSQL / isolated result
```

Не переключать production workers на новый endpoint до acceptance criteria и shadow comparison.

---

## 6. Расположение

Создать внутри:
```text
nika-matching-pilot-starter/
```

новый модуль:
```text
lead-matching-service/
```

Предпочтительная структура:
```text
lead-matching-service/
├── src/
│   ├── api/
│   ├── adapters/
│   ├── gates/
│   ├── parser/
│   ├── normalization/
│   ├── matching/
│   ├── repositories/
│   ├── services/
│   ├── config/
│   └── index.js
├── tests/
│   ├── unit/
│   ├── integration/
│   ├── regression/
│   └── fixtures/
├── scripts/
│   ├── shadow-compare.js
│   ├── replay-message.js
│   └── benchmark.js
├── package.json
├── .env.example
└── README.md
```

Обязательное разделение: Transport / Classification / AI Parsing / Normalization / Matching Core / Persistence / Notification boundary.

---

## 7. Stack

Использовать:
```text
Node.js
plain JavaScript
CommonJS
Fastify
PostgreSQL
pg
Zod
dotenv
```

Не переводить на TypeScript. Не использовать ORM. Не добавлять Redis/Kafka/RabbitMQ/Elasticsearch/OpenSearch/FAISS/Vector DB/ML recommender без отдельной необходимости.

---

## 8. Git safety — обязательный первый этап

Перед реализацией:
```text
git status
git ls-files
git check-ignore
```

Проверить исключение `.env`, `sessions/`, Telegram `.session`, WhatsApp auth state, API tokens, private keys, credentials.

Обеспечить version control для исходников нового сервиса, не добавляя secrets.

---

## 9. Основной production endpoint

Основной endpoint:
```text
POST /v1/webhooks/messages
```

Provider определяется через `provider`.

Можно добавить aliases:
```text
POST /v1/webhooks/telegram
POST /v1/webhooks/whatsapp
```

Внутри все вызывают один pipeline.

---

## 10. Telegram raw contract

Поддержать фактический worker payload.

```json
{
  "event": "message.new",
  "provider": "telegram",
  "chat_id": "-100123456789",
  "message_id": "308394",
  "sender_id": "1559760609",
  "sender_name": "John Doe",
  "sender_username": "john",
  "text": "Need 2BR in Business Bay up to AED 2.5M",
  "posted_at": "2026-09-17T12:30:00Z",
  "chat_name": "Dubai Brokers",
  "source_url": "https://t.me/example/308394"
}
```

---

## 11. WhatsApp raw contract

```json
{
  "event": "message.new",
  "provider": "whatsapp",
  "chat_id": "120363...",
  "message_id": "...",
  "sender_id": "...",
  "sender_id_alt": "...",
  "sender_name": "...",
  "text": "Need 2BR Business Bay max 2.5M",
  "posted_at": "2026-09-17T12:30:00Z"
}
```

Поддержать текущую LID / `remoteJidAlt` логику worker.

---

## 12. Provider adapters

Raw provider payload сначала проходит через `TelegramAdapter` или `WhatsAppAdapter`.

На выходе всегда один объект:
```text
UnifiedRawMessage
```

---

## 13. UnifiedRawMessage

```json
{
  "schema_version": "1.0",
  "provider": "telegram",
  "source_message_id": "telegram:-100123456789:308394",
  "external_message_id": "308394",
  "chat_id": "-100123456789",
  "group_name": "Dubai Brokers",
  "sender_id": "1559760609",
  "sender_id_alt": null,
  "author_name": "John Doe",
  "author_username": "john",
  "author_contact": "https://t.me/john",
  "original_text": "Need 2BR in Business Bay max 2.5M",
  "source_url": "https://t.me/...",
  "posted_at": "2026-09-17T12:30:00Z",
  "received_at": "2026-09-17T12:30:03Z"
}
```

`original_text` — канонический исходный текст запроса и должен сохраняться 1:1.

---

## 14. Validation

Raw webhook валидировать через Zod.

Invalid payload:
```text
HTTP 400
```

с машинно читаемым error code.

Не запускать AI и matching при invalid webhook.

---

## 15. Primary Lead Gate

После normalization запускается быстрый deterministic pre-filter — standalone аналог текущего `Raw Monitor Primary Lead Gate`.

Цель:
```text
отсеять очевидный нерелевантный мусор
и очевидную рекламу
до OpenAI вызова
```

Gate не должен пытаться окончательно понимать сложный buyer intent.

---

## 16. Исправление текущей ошибки Primary Gate

Текущая логика:
```text
hasDemand && positiveScore >= 5
→ ACCEPT
```
может принять:
```text
Have a client looking to buy?
Send us your client's requirements.
```
за buyer request.

Это исправить.

Нельзя использовать `client`, `looking`, `buyer`, `requirements` без определения направления запроса.

---

## 17. Directional classification

Различать:

```text
SENDER HAS DEMAND
"My client needs..."
"We are looking for..."
"Need options for..."
"Looking to buy..."
```

и:

```text
RECIPIENT HAS DEMAND
"Do you have a buyer?"
"Send me your clients."
"Send your client's requirements."
"Agents welcome."
```

Вторая категория — не buyer request.

---

## 18. Pre-filter result

Gate возвращает:
```json
{
  "passed": true,
  "decision": "review_with_ai",
  "positive_signals": [],
  "negative_signals": [],
  "reason": null
}
```

или rejected.

Rejected messages не идут в OpenAI.

---

## 19. Не делать Regex единственным классификатором

Regex — cheap first gate.

Final message classification выполняет AI.

```text
cheap deterministic gate
↓
AI classifier/parser
↓
deterministic matching
```

---

## 20. Deduplication

После cheap gate и до OpenAI.

Dedup key минимум:
```text
normalized text
sender identity
provider
```

Default window:
```text
48 hours
```

---

## 21. Dedup behavior

Duplicate:
```text
status = DUPLICATE
```

Не вызывать OpenAI и не матчить повторно.

---

## 22. AI layer

AI полностью переносится внутрь Lead Matching Service.

Создать:
```text
parser/openai-client.js
parser/prompt.js
parser/schema.js
```

Core matcher никогда не вызывает OpenAI напрямую.

---

## 23. AI model

Initial default:
```text
OPENAI_MODEL=gpt-4o-mini
```

Модель должна задаваться через env.

---

## 24. AI выполняет две функции

Один вызов:
```text
1. Classification
2. Structured Parsing
```

Не делать два OpenAI вызова на одно сообщение без необходимости.

---

## 25. AI output schema

```json
{
  "message_class": "buyer_request",
  "demand_owner": "sender",
  "promotion": false,
  "spam": false,
  "transaction_type": "SALE",
  "area": "Business Bay",
  "project": "The Edge",
  "building": null,
  "property_type": "Apartment",
  "bedrooms_min": 1,
  "bedrooms_max": 1,
  "budget_min": null,
  "budget_max": 1300000,
  "furnishing": null,
  "cash_buyer": true,
  "confidence": 0.96
}
```

---

## 26. message_class

Allowed:
```text
buyer_request
seller_request
inventory_ad
broker_solicitation
general_advertisement
other
unknown
```

Matching запускается только при:
```text
message_class = buyer_request
```

---

## 27. demand_owner

Allowed:
```text
sender
recipient
unknown
```

Для automatic matching обязательно:
```text
demand_owner = sender
```

---

## 28. Emaar advertisement regression

Input:
```text
Have a client looking to buy?
Send us your client's requirements.
500+ units for Sale & Rent.
Commission...
```

Expected:
```json
{
  "message_class": "broker_solicitation",
  "demand_owner": "recipient",
  "promotion": true
}
```

Result:
```text
REJECTED
```

Release blocker.

---

## 29. Defense in depth

Если AI ошибочно пропустил сообщение, но извлек только Area без budget/bedrooms/property_type/project/building:
```text
INSUFFICIENT_CRITERIA
```

---

## 30. StructuredRequest

```json
{
  "schema_version": "1.0",
  "request_id": "telegram:-100123:308394",
  "source": {
    "provider": "telegram",
    "source_url": "...",
    "group_name": "...",
    "author_name": "...",
    "author_contact": "...",
    "original_text": "Need 2BR in Business Bay max 2.5M"
  },
  "transaction_type": "SALE",
  "area": "Business Bay",
  "project": "The Edge",
  "building": null,
  "property_type": "Apartment",
  "bedrooms_min": 1,
  "bedrooms_max": 1,
  "budget_min": null,
  "budget_max": 1300000,
  "furnishing": null,
  "cash_buyer": true,
  "ai_confidence": 0.96
}
```

`original_text` сохраняется 1:1.

---

## 31. Второй технический endpoint

Создать:
```text
POST /v1/match
```

Принимает готовый StructuredRequest и пропускает adapters/gate/dedup/OpenAI.

Нужен для tests, debugging, dashboard, future Joker, manual calls, other services.

---

## 32. Matching core полностью deterministic

AI понимает сообщение.

Core решает, какие properties подходят.

Core не знает про OpenAI, Telegram, WhatsApp, n8n, Joker, Google Sheets.

---

## 33. Reuse existing core where useful

Изучить существующие:
```text
src/core/matcher.js
src/core/scoring.js
src/core/aliases.js
src/core/normalize.js
```

Переиспользовать безопасные utilities, но matching strategy изменить согласно этому ТЗ.

---

## 34. Главный принцип нового matching

```text
FILTER FIRST
RANK SECOND
```

Score больше не решает допустимость объекта.

---

## 35. Candidate Retrieval

Не использовать:
```text
SELECT all ACTIVE stock
→ filter everything в Node
```
если SQL может сузить выборку заранее.

Repository строит candidate query из hard filters.

---

## 36. ACTIVE stock

Всегда:
```text
status = ACTIVE
```

Другие statuses не рассматривать.

---

## 37. Transaction — hard filter

SALE ↔ SALE.

RENT ↔ RENT.

Mismatch:
```text
candidate excluded
```

---

## 38. Property Type — hard filter

Если указан canonical type:
```text
Apartment
Villa
Townhouse
Commercial
Land
```
stock должен быть совместим после alias normalization.

Missing → criterion inactive.

---

## 39. Location hierarchy

Использовать максимальную специфичность:
```text
Building
↓
Project
↓
Area
```

---

## 40. Building

Если Building указан:
```text
candidate pool = exact canonical building
```

Другие buildings не рассматриваются.

0 результатов:
```text
NO_MATCH
reason = no_stock_in_building
```

---

## 41. Project

Сначала проверить actual stock schema.

Если отдельный `project` существует:
```text
candidate pool = exact canonical project
```

Если project field нет:
- не делать большой schema redesign автоматически;
- использовать Building и Area;
- оставить `project` в request schema;
- зафиксировать limitation.

---

## 42. Area

Если Building/Project не указаны:
```text
candidate pool = exact canonical area
```

Другие районы не попадают в scoring.

---

## 43. Critical The Edge regression

Request:
```text
The Edge
1BR
Apartment
AED 1.3M
```

Stock:
```text
340 Riverside Crescent
1BR
Apartment
AED 1.235M
```

Riverside:
```text
MUST NEVER ENTER CANDIDATE POOL
```

Если The Edge отсутствует:
```text
NO_MATCH
```

---

## 44. Alias resolution

Использовать существующую:
```text
matching.matching_aliases
```

для area/building/property_type и project, если schema поддерживает.

---

## 45. Alias matching

v1:
```text
exact normalized alias lookup
```

Не добавлять fuzzy matching, LLM alias resolver, embeddings, Levenshtein auto-accept.

---

## 46. Ambiguous aliases

Если alias соответствует нескольким entities и нельзя определить правильную:
```text
NO_MATCH
reason = ambiguous_location
```

Не угадывать.

---

## 47. Unknown specific location

Если конкретный Building/Project не найден:
```text
NO_MATCH
reason = location_not_found
```

Не делать fallback на whole-area или all-stock.

---

## 48. Minimum specificity

Automatic matching разрешен при:
```text
Location
+
минимум 1 дополнительный criterion
```

Дополнительный:
```text
budget
bedrooms
property_type
```

---

## 49. Examples

```text
Business Bay only
→ INSUFFICIENT_CRITERIA

Business Bay + 2BR
→ allowed

Business Bay + max 2.5M
→ allowed

The Edge + Apartment
→ allowed
```

---

## 50. Budget — hard filter

Default:
```text
MATCH_PRICE_TOLERANCE_PCT=10
```

Если max:
```text
price <= budget_max × 1.10
```

---

## 51. Budget Range

Min+max:
```text
price >= min
price <= max × 1.10
```

Only max:
```text
price <= max × 1.10
```

Only min:
```text
price >= min
```

---

## 52. Bedrooms — hard filter

Exact request → exact stock.

Не принимать автоматически соседние bedroom values.

---

## 53. Bedroom ranges

Поддержать:
```text
2BR
2–3BR
3BR+
Studio
```

Internal:
```text
bedrooms_min
bedrooms_max
```

Studio = 0.

---

## 54. Maid room

Не считать maid room как bedroom:
```text
3BR + maid
→ bedrooms = 3
```

---

## 55. Surviving candidate = valid match

Если candidate прошел все active hard filters:
```text
VALID MATCH
```

Нет дополнительного threshold `score >= 70`.

---

## 56. Score нужен только для ranking

Score 0–100 используется только для:
```text
sort
explanation
future prioritization
```

---

## 57. Ranking weights

Initial:
```text
Location       50
Budget         30
Bedrooms       15
Property Type   5
```

---

## 58. Missing field behavior

Если criterion не указан:
```text
EXCLUDE COMPONENT
```

Не давать full score и не штрафовать нулем.

---

## 59. Dynamic weight normalization

Если активны только Location + Budget:
```text
50 + 30 = 80
```

Нормализовать активные веса до 100%.

---

## 60. Location score

После hard filter:
```text
Exact Building = 100
Exact Project  = 95
Area-only      = 80
```

---

## 61. Budget score

```text
price <= budget_max → 100
0–5% over           → 75
5–10% over          → 50
```

>10% уже rejected hard filter.

---

## 62. Bedrooms score

Если criterion active и candidate совместим:
```text
100
```

---

## 63. Property Type score

Если criterion active и candidate совместим:
```text
100
```

---

## 64. Persistence

Использовать текущий PostgreSQL:
```text
schema matching
```

Не создавать отдельный PostgreSQL.

---

## 65. Existing tables

Переиспользовать:
```text
matching.stock_inventory
matching.matching_aliases
matching.stock_sync_runs
matching.match_runs
matching.match_results
matching.ai_usage_log
```

---

## 66. Existing DB repositories

Изучить:
```text
src/db/*Repository.js
```

Переиспользовать, если подходят. Не держать две параллельные SQL implementations без причины.

---

## 67. Database migration policy

Предпочтительно реализовать на существующей schema.

Любая migration:
```text
additive only
backward-compatible
no destructive changes
```

---

## 68. Match run persistence

Хранить минимум:
```text
source_message_id
provider
source_url
original_text
result_status
parsed_request
normalized_request
no_match_reason
best_score
matches_count
created_at
```

`original_text` хранить 1:1 без AI rewrite/summary/translation/normalization.

Если отдельного поля нет — проверить существующие JSON/relations; при необходимости сделать минимальную migration.

---

## 69. Match results

Каждый valid Match `request ↔ stock_id` сохраняется отдельно.

Не использовать Top-3/Top-10 truncation.

---

## 70. Idempotency

Сохранить:
```text
UNIQUE(source_message_id, stock_id)
```

Повторный result:
```text
UPSERT
```

---

## 71. AI usage logging

Логировать:
```text
model
prompt_tokens
completion_tokens
total_tokens
estimated_cost_usd
request/source id
timestamp
```

Failure usage logging не должен ломать основной pipeline.

---

## 72. Result statuses

Минимум:
```text
REJECTED
DUPLICATE
PARSER_ERROR
INSUFFICIENT_CRITERIA
NO_MATCH
MATCH
ERROR
```

---

## 73. no_match_reason

Минимум:
```text
advertisement
not_buyer_request
recipient_owned_demand
spam
location_missing
location_not_found
ambiguous_location
no_stock_in_area
no_stock_in_project
no_stock_in_building
transaction_mismatch
property_type_mismatch
over_budget
bedrooms_mismatch
no_candidates
```

---

## 74. API response

MatchResult должен включать parsed request, matches, source metadata, `original_text` и `source_url`, чтобы Notification Router не обращался обратно к provider.

---

## 75. Health endpoint

```text
GET /health
```

```json
{
  "status": "ok",
  "database": "ok",
  "openai": "configured",
  "matcher_version": "2"
}
```

Не делать live OpenAI call на каждый health.

---

## 76. Internal API security

Default:
```text
MATCHER_HOST=127.0.0.1
```

Config:
```text
MATCHER_HOST
MATCHER_PORT
MATCHER_API_KEY
```

Workers получают API key через env.

---

## 77. Worker delivery reliability

Retry transient errors:
```text
network failure
HTTP 429
HTTP 5xx
```

Ограниченный exponential backoff.

Не retry:
```text
400
401
```

---

## 78. Worker timeout

Webhook POST должен иметь reasonable timeout и не блокировать listener бесконечно.

---

## 79. AI latency / concurrency

Fastify + async pipeline должен позволять обрабатывать несколько requests параллельно.

Отдельная queue на MVP не требуется.

---

## 80. API response semantics для workers

На MVP допустим synchronous full result.

Worker не использует MatchResult для business logic.

Для worker:
```text
2xx = accepted/processed
```

---

## 81. Logging

Structured logs:
```text
request_id
provider
source_message_id
gate_decision
duplicate
ai_model
classification
candidate_count
matches_count
best_score
result_status
duration_ms
```

---

## 82. PII

Полный message body не логировать по умолчанию.

Не логировать:
```text
API tokens
DB passwords
Telegram sessions
WhatsApp auth data
OpenAI key
```

---

## 83. Debug mode

Env:
```text
MATCH_DEBUG=false
```

При true можно возвращать gate/parser/candidate breakdown без secrets.

---

## 84. Tests — baseline

Перед изменениями запустить существующие suites.

Audit baseline:
```text
Unit        169 / 169
Contracts    17 / 17
Integration  19 / 19
TOTAL       205 / 205
```

---

## 85. New test categories

Добавить:
```text
Provider adapter tests
Envelope normalization tests
Primary Gate tests
Dedup tests
AI parser contract tests
Normalization tests
Matching tests
Repository integration tests
API tests
Regression tests
Notification rendering contract tests
```

---

## 86. OpenAI tests

Unit tests не обращаются к реальному OpenAI.

Live OpenAI только через explicit flag:
```text
RUN_OPENAI_LIVE_TESTS=false
```

---

## 87. Regression — genuine buyer

```text
My client is looking for a 2BR in Business Bay,
budget up to AED 2.5M.
```

Expected:
```text
buyer_request
demand_owner=sender
matching runs
```

---

## 88. Regression — Emaar ad

```text
Have a client looking to buy?
Send us your client's requirements.
500+ units available.
Agents welcome.
```

Expected:
```text
REJECTED
```

---

## 89. Regression — direction inversion

Test separately:
```text
"My client is looking for..."
"Do you have a client looking for...?"
```

Они обязаны классифицироваться по-разному.

---

## 90. Regression — The Edge

```text
Need 1BR The Edge
AED 1.3M
```

Если stock The Edge отсутствует:
```text
NO_MATCH
```

Никогда Riverside.

---

## 91. Regression — area only

```text
Business Bay
```

Expected:
```text
INSUFFICIENT_CRITERIA
```

---

## 92. Regression — Area + Bedrooms

```text
Business Bay
2BR
```

Allowed.

Другие районы не candidates.

---

## 93. Regression — budget

Max 2.5M + 10% tolerance:
```text
2.50 → pass
2.60 → pass
2.75 → pass
2.76 → reject
```

---

## 94. Regression — bedrooms

```text
2BR → pass
1BR → reject
3BR → reject
```

---

## 95. Regression — missing criteria

Missing bedrooms:
```text
do not filter bedrooms
do not score bedrooms
```

Missing budget:
```text
do not filter budget
do not score budget
```

---

## 96. Regression — wrong location rescue

Property:
```text
wrong location
perfect price
perfect bedrooms
perfect type
```

Expected:
```text
REJECTED BEFORE SCORING
```

Release blocker.

---

## 97. Replay tooling

Создать:
```text
scripts/replay-message.js
```

Пример:
```bash
node scripts/replay-message.js tests/fixtures/telegram-business-bay.json
```

Pipeline:
```text
adapter → gate → AI mock/live → matcher
```

---

## 98. Shadow comparison

Создать:
```text
scripts/shadow-compare.js
```

Сравнивать current matcher vs new service:
```text
classification differences
old matches
new matches
false-positive removals
new NO_MATCH
score differences
```

---

## 99. Shadow mode перед cutover

После локального завершения предусмотреть:
```text
worker
→ current n8n
AND
→ new service
```

Новый endpoint в shadow/read-only.

Не включать dual-send без explicit approval.

---

## 100. Performance

Не оптимизировать преждевременно.

Исправить текущую проблему:
```text
load entire ACTIVE stock into Node every request
```

Candidate filtering максимально в PostgreSQL.

---

## 101. Recommended indexes review

Проверить необходимость indexes по:
```text
status
transaction_type
area
building
property_type
bedrooms
selling_price
```

Создавать только при необходимости/query plan.

---

## 102. Concurrency

Service корректно обрабатывает несколько messages параллельно.

Без global mutable request state.

Alias cache допустим только с безопасным TTL/invalidation.

---

## 103. Error handling

Разделить:
```text
CLIENT_ERROR
PARSER_ERROR
DATABASE_ERROR
EXTERNAL_AI_ERROR
INTERNAL_ERROR
```

Ошибка одного request не должна падать весь service.

---

## 104. OpenAI failure

При timeout/429/5xx/invalid JSON использовать ограниченный retry.

После исчерпания:
```text
PARSER_ERROR
```

Raw message не теряется.

---

## 105. Raw message persistence

До или сразу после gate сохранить достаточно traceability.

Не создавать duplicate ownership `devi_messages` без анализа.

Минимум:
```text
source_message_id
provider
original_text
source_url
group_name
author_name
author_contact
posted_at
```

---

## 106. Dashboard

Текущий dashboard не переписывать.

Новый service должен писать совместимые данные, чтобы dashboard продолжал видеть результаты после будущего cutover.

---

## 107. Notification boundary

Notification Router — отдельный слой:
```text
Match persisted
↓
Notification Router
↓
Responsible Broker / shared test channel
↓
Telegram / WhatsApp / Email
```

Matching core не содержит Telegram Bot API calls.

---

## 108. Telegram notification — обязательный формат

Каждое future Telegram уведомление о Match должно содержать:

```text
1. исходный текст запроса 1:1
2. источник
3. ссылку на оригинальное сообщение, если существует
4. все найденные matching stock
5. match score / explanation
```

Источник:
```text
UnifiedRawMessage.original_text
```

Запрещено заменять его AI summary/rewrite/translation/grammar correction/normalization/shortened paraphrase/StructuredRequest summary.

---

## 109. Telegram notification example

```text
🔥 NEW BUYER MATCH

REQUEST — ORIGINAL MESSAGE

Looking for my client:
2BR in Business Bay
Budget up to AED 2.5M
Cash buyer
Need options ASAP

SOURCE
Telegram
Dubai Real Estate, UAE Brokers

ORIGINAL MESSAGE
https://t.me/example/308394

MATCHED STOCK

1. Peninsula Five
2BR
AED 2.40M
Match score: 100

2. Executive Towers
2BR
AED 2.48M
Match score: 94
```

---

## 110. Telegram original text rule

Оригинальный текст должен отображаться максимально 1:1 с сохранением:
```text
переносов строк
пунктуации
регистра
эмодзи
содержания
```

Допустим только safe escaping для Telegram parse mode, не меняющий отображаемый текст.

---

## 111. Source URL rule

Если `source_url` есть — обязательно добавить clickable link.

Если отсутствует:
```text
Original message link: unavailable
```

---

## 112. WhatsApp source case

Для WhatsApp permalink может отсутствовать.

Тогда:
```text
Source: WhatsApp
Original message link: unavailable
```

Но полный `original_text` обязателен.

---

## 113. Telegram length limit / chunking

Нельзя молча обрезать original_text или matched stock.

Если лимит превышен:
```text
Message 1
→ request header
→ полный original_text
→ source
→ source_url

Message 2..N
→ matching stock
```

Все части содержат общий `request_id`.

---

## 114. All matches rule

Если request имеет 7 valid matches, Notification Router должен доставить все 7.

Запрещено Top-3/Top-5/Top-N, если это приводит к потере valid matches.

---

## 115. Notification data source

Notification Router НЕ должен повторно читать сообщение из Telegram/WhatsApp.

Использовать persistence:
```text
original_text
source_url
provider
group_name
author_name
request_id
match_results
```

---

## 116. Notification regression tests

Обязательные tests:

1. Original text preservation.
2. Link included when source_url exists.
3. No-link case works.
4. Long request chunks without loss.
5. All matches preserved across chunks.

---

## 117. Joker boundary

Future Joker integration может:
```text
Joker
→ create StructuredRequest
→ POST /v1/match
```

или участвовать в stock sync.

Joker не является dependency сервиса.

---

## 118. Local run

Добавить:
```bash
npm run dev
npm start
npm test
npm run test:unit
npm run test:integration
npm run test:regression
```

Опционально:
```bash
npm run shadow
npm run replay
```

---

## 119. Docker

Добавить Dockerfile для service.

Не поднимать новый production PostgreSQL.

Dev/integration tests могут использовать disposable PostgreSQL.

---

## 120. Docker service

После development можно добавить в compose:
```text
lead-matching-service
```

Но production worker redirect автоматически не делать.

---

## 121. Environment

`.env.example` минимум:
```text
NODE_ENV=development
MATCHER_HOST=127.0.0.1
MATCHER_PORT=8095
MATCHER_API_KEY=
DATABASE_URL=
OPENAI_API_KEY=
OPENAI_MODEL=gpt-4o-mini
MATCH_PRICE_TOLERANCE_PCT=10
DEDUP_WINDOW_HOURS=48
MATCH_DEBUG=false
LOG_LEVEL=info
```

---

## 122. Secrets

Не копировать реальные secrets в source, README, fixtures, git, logs, final report.

---

## 123. Deployment phases

Phase 1 — Baseline:
```text
audit current code
run 205 tests
secure git state
```

Phase 2 — Standalone service:
```text
provider adapters
normalization
gate
dedup
AI parser
matcher
repositories
API
```

Phase 3 — Local tests:
```text
unit
integration
regression
replay
```

Phase 4 — Shadow:
```text
historical replay
old vs new
```

Phase 5 — Server deployment:
```text
deploy service
health check
no worker cutover yet
```

Phase 6 — Worker cutover: отдельное задание.

Phase 7 — Notification Router cutover: отдельное задание.

---

## 124. Worker cutover target

После отдельного approval:

```text
Сейчас:
Telegram Worker
WhatsApp Worker
       ↓
n8n

Цель:
Telegram Worker
WhatsApp Worker
       ↓
Lead Matching Service
```

n8n больше не участвует в matching path.

---

## 125. Что после cutover остается в n8n

Не удалять весь n8n workflow автоматически.

Lane B и другие workflows могут продолжать работать независимо.

Удаление старых matching nodes — отдельная migration задача после доказанной стабильности.

---

## 126. Acceptance Criteria

Сервис готов только если:

1. Запускается без n8n.
2. Принимает raw Telegram webhook.
3. Принимает raw WhatsApp webhook.
4. Делает provider normalization.
5. Primary Lead Gate внутри service.
6. Dedup внутри service.
7. OpenAI classification/parser внутри service.
8. Emaar false positive отклоняется.
9. StructuredRequest валидируется.
10. Aliases читаются без n8n.
11. Stock читается без n8n.
12. Wrong location не спасается score.
13. The Edge не матчится на Riverside.
14. Missing criterion не получает fake score.
15. Location-only не дает auto matches.
16. Все valid candidates возвращаются.
17. Score только ranks valid matches.
18. match_runs/results сохраняются без n8n.
19. AI usage сохраняется.
20. original_text сохраняется 1:1.
21. source_url сохраняется.
22. MatchResult содержит enough source metadata.
23. Notification contract требует original_text 1:1 + source URL + все matches.
24. Long notifications chunked без потери текста/matches.
25. Telegram transport отсутствует в matching core.
26. WhatsApp transport отсутствует в matching core.
27. Joker dependency отсутствует.
28. Старые tests проходят.
29. Новые tests проходят.
30. Production workflow не переключен без отдельного approval.

---

## 127. Expected architecture after implementation

Во время implementation:

```text
PRODUCTION — UNCHANGED

Telegram Worker ─┐
                 ├──► n8n current production pipeline
WhatsApp Worker ─┘
```

Параллельно:

```text
NEW STANDALONE SERVICE

Raw Worker Webhook
↓
Provider Adapter
↓
Normalize
↓
Primary Gate
↓
Dedup
↓
AI Classifier + Parser
↓
StructuredRequest
↓
Alias Resolution
↓
SQL Candidate Retrieval
↓
Hard Filters
↓
Ranking
↓
Persistence
↓
MatchResult
```

Future notification:
```text
Persisted MatchResult
+ persisted original_text
+ source_url
↓
Notification Router
↓
Telegram / WhatsApp / Email
```

---

## 128. Финальный отчет исполнителя

Предоставить:

```text
LEAD MATCHING SERVICE IMPLEMENTATION REPORT

1. Baseline test results
2. Git / repository state
3. Files created
4. Architecture implemented
5. Raw Telegram contract
6. Raw WhatsApp contract
7. UnifiedRawMessage schema
8. Primary Lead Gate implementation
9. Dedup implementation
10. OpenAI classifier/parser
11. StructuredRequest schema
12. Matching algorithm
13. Candidate SQL strategy
14. Alias behavior
15. Persistence incl. original_text/source_url
16. API endpoints
17. Authentication
18. Tests
19. Critical regressions
20. Shadow comparison
21. Performance
22. Database migrations
23. Existing production code changed
24. Exact local start command
25. Exact Docker start command
26. Remaining limitations
27. Recommended worker cutover
28. Recommended Notification Router cutover
```

---

## 129. Главный принцип реализации

```text
AI
→ понимает человеческое сообщение

Deterministic Filters
→ решают, может ли property быть подходящим

Ranking
→ сортирует уже допустимые properties
```

AI и score не компенсируют hard constraint mismatch.

И отдельно:

```text
ORIGINAL MESSAGE
→ никогда не заменяется AI summary
→ сохраняется 1:1
→ передается брокеру вместе с matching result
```

Итог:
```text
RAW MESSAGE
→ UNDERSTAND
→ FILTER
→ MATCH
→ RANK
→ STORE
→ NOTIFY WITH ORIGINAL CONTEXT
```

Без зависимости matching core от n8n.
