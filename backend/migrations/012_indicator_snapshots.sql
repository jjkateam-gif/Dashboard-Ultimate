-- Add indicator snapshot and additional learning data to best_trades_log
ALTER TABLE best_trades_log ADD COLUMN IF NOT EXISTS signal_snapshot JSONB;
ALTER TABLE best_trades_log ADD COLUMN IF NOT EXISTS raw_probability INTEGER;
ALTER TABLE best_trades_log ADD COLUMN IF NOT EXISTS ev DECIMAL(10,4);
ALTER TABLE best_trades_log ADD COLUMN IF NOT EXISTS optimal_lev INTEGER;
ALTER TABLE best_trades_log ADD COLUMN IF NOT EXISTS atr_value DECIMAL(20,8);
ALTER TABLE best_trades_log ADD COLUMN IF NOT EXISTS hits JSONB;
ALTER TABLE best_trades_log ADD COLUMN IF NOT EXISTS misses JSONB;
ALTER TABLE best_trades_log ADD COLUMN IF NOT EXISTS volume_ratio DECIMAL(10,4);
ALTER TABLE best_trades_log ADD COLUMN IF NOT EXISTS confluence_score DECIMAL(5,4);

-- Index for retention cleanup
CREATE INDEX IF NOT EXISTS idx_bt_log_created_outcome ON best_trades_log(created_at, outcome);
