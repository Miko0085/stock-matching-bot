# SQL migrations

Implementation agent must create idempotent migrations for:

1. `stock_inventory`
2. `matching_aliases`
3. `stock_sync_runs`
4. `match_runs`
5. `match_results`
6. dashboard views as needed

Do not alter/drop the existing `devi_messages` table.
