-- Persist the campaign_updates.updated_at column used by the update endpoints.
-- schema.sql already declared it, but no migration ever created it, so
-- databases built with `npm run migrate` were missing a column live code
-- reads and writes (#1045).
ALTER TABLE campaign_updates
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT NOW();

-- Backfill rows that predate the column so clients never receive NULL.
UPDATE campaign_updates
   SET updated_at = COALESCE(created_at, NOW())
 WHERE updated_at IS NULL;
