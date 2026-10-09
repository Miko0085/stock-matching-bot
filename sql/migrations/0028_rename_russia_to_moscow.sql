-- Renames matching_russia -> matching_moscow (2026-09-28, same day as the
-- matching/matching_rf -> matching_uae/matching_russia rename in 0027).
--
-- Reason: a live data audit found the "rf" bucket's original design (every
-- Joker object NOT explicitly Turkey/UAE/Oman/Saudi, regardless of its real
-- region) was pulling in Санкт-Петербург/Краснодарский край (Сочи)/
-- Татарстан (Казань)/Самарская область, Moscow OBLAST (not the city), and
-- even objects tagged Узбекистан (Ташкент) and Грузия (Батуми) -- countries
-- with nothing to do with Russia at all. The user asked to scope this
-- schema strictly to the city of Moscow (src/joker/joker-market-router.js's
-- resolveMarket() now requires region === 'Москва' exactly), so the name
-- "russia" was no longer accurate -- "moscow" matches the real scope.
--
-- Guarded and idempotent, same pattern as 0027: checks pg_namespace first,
-- so it's a no-op if already renamed or on a fresh database that never had
-- matching_russia in the first place (a fresh DB creates matching_moscow
-- directly once this migration is updated in a later cleanup -- for now,
-- 0018/0025 still create matching_rf under its historical name, 0027
-- renames it to matching_russia, and this migration renames it once more
-- to matching_moscow; the three-step history is kept, not rewritten).
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'matching_russia')
     AND NOT EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'matching_moscow') THEN
    EXECUTE 'ALTER SCHEMA matching_russia RENAME TO matching_moscow';
  END IF;
END $$;
