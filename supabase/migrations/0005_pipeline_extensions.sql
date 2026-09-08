-- ============================================================
-- Server-side scheduling and HTTP for the distressed-property
-- research pipeline.
--
--   * pg_cron  — schedules the Tuesday/Thursday research runs.
--   * pg_net   — lets the database invoke the Edge Function that
--                does the research (async HTTP from SQL).
--
-- Both are additive; nothing existing changes.
-- ============================================================
create extension if not exists pg_net with schema extensions;
create extension if not exists pg_cron;
