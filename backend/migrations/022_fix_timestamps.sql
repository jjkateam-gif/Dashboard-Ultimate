-- Migration 022: Convert all remaining TIMESTAMP columns to TIMESTAMPTZ
-- Tables affected: best_trades_settings, best_trades_log, prediction_state, prediction_trades
-- Safe to re-run: wrapped in DO blocks with exception handling

-- ══════════════════════════════════════════════════════════════
-- A) best_trades_settings.updated_at  (from 009_best_trades.sql)
-- ══════════════════════════════════════════════════════════════
DO $$ BEGIN
  ALTER TABLE best_trades_settings
    ALTER COLUMN updated_at TYPE TIMESTAMPTZ USING updated_at AT TIME ZONE 'UTC';
EXCEPTION
  WHEN undefined_table THEN NULL;
  WHEN undefined_column THEN NULL;
  WHEN others THEN
    RAISE NOTICE 'best_trades_settings.updated_at conversion skipped: %', SQLERRM;
END $$;

-- ══════════════════════════════════════════════════════════════
-- B) best_trades_log: created_at, resolved_at, last_seen_at
--    (from 009_best_trades.sql and 014_scan_count.sql)
-- ══════════════════════════════════════════════════════════════
DO $$ BEGIN
  ALTER TABLE best_trades_log
    ALTER COLUMN created_at TYPE TIMESTAMPTZ USING created_at AT TIME ZONE 'UTC';
EXCEPTION
  WHEN undefined_table THEN NULL;
  WHEN undefined_column THEN NULL;
  WHEN others THEN
    RAISE NOTICE 'best_trades_log.created_at conversion skipped: %', SQLERRM;
END $$;

DO $$ BEGIN
  ALTER TABLE best_trades_log
    ALTER COLUMN resolved_at TYPE TIMESTAMPTZ USING resolved_at AT TIME ZONE 'UTC';
EXCEPTION
  WHEN undefined_table THEN NULL;
  WHEN undefined_column THEN NULL;
  WHEN others THEN
    RAISE NOTICE 'best_trades_log.resolved_at conversion skipped: %', SQLERRM;
END $$;

DO $$ BEGIN
  ALTER TABLE best_trades_log
    ALTER COLUMN last_seen_at TYPE TIMESTAMPTZ USING last_seen_at AT TIME ZONE 'UTC';
EXCEPTION
  WHEN undefined_table THEN NULL;
  WHEN undefined_column THEN NULL;
  WHEN others THEN
    RAISE NOTICE 'best_trades_log.last_seen_at conversion skipped: %', SQLERRM;
END $$;

-- ══════════════════════════════════════════════════════════════
-- C) prediction_state.updated_at  (from 008_prediction_state.sql)
-- ══════════════════════════════════════════════════════════════
DO $$ BEGIN
  ALTER TABLE prediction_state
    ALTER COLUMN updated_at TYPE TIMESTAMPTZ USING updated_at AT TIME ZONE 'UTC';
EXCEPTION
  WHEN undefined_table THEN NULL;
  WHEN undefined_column THEN NULL;
  WHEN others THEN
    RAISE NOTICE 'prediction_state.updated_at conversion skipped: %', SQLERRM;
END $$;

-- ══════════════════════════════════════════════════════════════
-- D) prediction_trades: created_at, resolved_at  (from 008_prediction_state.sql)
-- ══════════════════════════════════════════════════════════════
DO $$ BEGIN
  ALTER TABLE prediction_trades
    ALTER COLUMN created_at TYPE TIMESTAMPTZ USING created_at AT TIME ZONE 'UTC';
EXCEPTION
  WHEN undefined_table THEN NULL;
  WHEN undefined_column THEN NULL;
  WHEN others THEN
    RAISE NOTICE 'prediction_trades.created_at conversion skipped: %', SQLERRM;
END $$;

DO $$ BEGIN
  ALTER TABLE prediction_trades
    ALTER COLUMN resolved_at TYPE TIMESTAMPTZ USING resolved_at AT TIME ZONE 'UTC';
EXCEPTION
  WHEN undefined_table THEN NULL;
  WHEN undefined_column THEN NULL;
  WHEN others THEN
    RAISE NOTICE 'prediction_trades.resolved_at conversion skipped: %', SQLERRM;
END $$;

-- ══════════════════════════════════════════════════════════════
-- E) Add gates_applied column to best_trades_log (#18/#21)
--    Tracks whether a trade went through the signal engine gates.
--    Existing records default to true (they came from the signal engine).
--    BloFin-only trades inserted by reconciliation get false.
-- ══════════════════════════════════════════════════════════════
DO $$ BEGIN
  ALTER TABLE best_trades_log ADD COLUMN IF NOT EXISTS gates_applied BOOLEAN DEFAULT true;
EXCEPTION
  WHEN undefined_table THEN NULL;
  WHEN others THEN
    RAISE NOTICE 'best_trades_log.gates_applied addition skipped: %', SQLERRM;
END $$;
