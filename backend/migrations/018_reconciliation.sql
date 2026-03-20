-- Migration 018: Add reconciliation columns for real BloFin trade data
-- Fixes the paper vs real performance tracking gap

-- Real fill data from BloFin
ALTER TABLE best_trades_log ADD COLUMN IF NOT EXISTS entry_price_real DECIMAL;
ALTER TABLE best_trades_log ADD COLUMN IF NOT EXISTS exit_price_real DECIMAL;
ALTER TABLE best_trades_log ADD COLUMN IF NOT EXISTS trading_fee_real DECIMAL;
ALTER TABLE best_trades_log ADD COLUMN IF NOT EXISTS blofin_pnl_usd DECIMAL;

-- Engine source tracking (which system placed the trade)
ALTER TABLE best_trades_log ADD COLUMN IF NOT EXISTS engine_source VARCHAR(30);
-- Values: 'best_trades_auto', 'best_trades_signal', 'manual_frontend', 'live_strategy', 'blofin_only'

-- Data source tracking (how the record was created)
ALTER TABLE best_trades_log ADD COLUMN IF NOT EXISTS data_source VARCHAR(20) DEFAULT 'signal_log';
-- Values: 'signal_log' (paper), 'signal_matched' (signal + real fill), 'blofin_only' (no signal record)

-- Exit reason if not already present (may exist from earlier migration)
ALTER TABLE best_trades_log ADD COLUMN IF NOT EXISTS exit_reason VARCHAR(20);
