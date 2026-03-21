-- Migration 021: Add slippage_pct column + backfill entry/exit prices for reconciled trades

-- ══════════════════════════════════════════════════════════════
-- A) Add slippage_pct column for tracking fill quality
-- ══════════════════════════════════════════════════════════════
ALTER TABLE best_trades_log ADD COLUMN IF NOT EXISTS slippage_pct DECIMAL(10,4);

-- ══════════════════════════════════════════════════════════════
-- B) Backfill entry_price / exit_price for reconciled trades
--    that have BloFin fill data but missing paper entry/exit
-- ══════════════════════════════════════════════════════════════

-- For signal_matched trades: fill entry_price from entry_price_real if entry_price is NULL
UPDATE best_trades_log
SET entry_price = entry_price_real
WHERE data_source = 'signal_matched'
  AND entry_price IS NULL
  AND entry_price_real IS NOT NULL;

-- For signal_matched trades: fill exit_price_real from target/stop based on outcome
-- If the trade won, exit was at target_price; if lost, exit was at stop_price
UPDATE best_trades_log
SET exit_price_real = CASE
  WHEN outcome = 'win' THEN target_price
  WHEN outcome = 'loss' THEN stop_price
  ELSE NULL
END
WHERE data_source IN ('signal_matched', 'blofin_only')
  AND exit_price_real IS NULL
  AND outcome IN ('win', 'loss');

-- For blofin_only trades: fill entry_price from entry_price_real
UPDATE best_trades_log
SET entry_price = entry_price_real
WHERE data_source = 'blofin_only'
  AND entry_price IS NULL
  AND entry_price_real IS NOT NULL;

-- ══════════════════════════════════════════════════════════════
-- C) Backfill slippage_pct for trades that have both intended and actual entry
--    slippage = (actual_fill - intended_entry) / intended_entry * 100
--    For longs, positive slippage = paid more (bad); for shorts, positive = sold lower (bad)
-- ══════════════════════════════════════════════════════════════
UPDATE best_trades_log
SET slippage_pct = CASE
  WHEN direction = 'long' THEN
    ROUND(((entry_price_real - entry_price) / NULLIF(entry_price, 0)) * 100, 4)
  WHEN direction = 'short' THEN
    ROUND(((entry_price - entry_price_real) / NULLIF(entry_price, 0)) * 100, 4)
  ELSE NULL
END
WHERE slippage_pct IS NULL
  AND entry_price_real IS NOT NULL
  AND entry_price IS NOT NULL
  AND entry_price > 0;

-- ══════════════════════════════════════════════════════════════
-- D) Backfill hours_to_resolution for resolved trades that have it NULL
-- ══════════════════════════════════════════════════════════════
UPDATE best_trades_log
SET hours_to_resolution = ROUND(EXTRACT(EPOCH FROM (COALESCE(closed_at, resolved_at) - created_at)) / 3600.0, 2)
WHERE hours_to_resolution IS NULL
  AND outcome IS NOT NULL
  AND (closed_at IS NOT NULL OR resolved_at IS NOT NULL);
