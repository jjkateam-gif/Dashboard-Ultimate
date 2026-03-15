-- Add timeframe column to best_trades_log for per-TF win rate tracking
ALTER TABLE best_trades_log ADD COLUMN IF NOT EXISTS timeframe VARCHAR(10) DEFAULT '4h';

-- Index for fast per-TF stats queries
CREATE INDEX IF NOT EXISTS idx_bt_log_timeframe ON best_trades_log(timeframe);

-- Composite index for resolved trades by timeframe
CREATE INDEX IF NOT EXISTS idx_bt_log_tf_outcome ON best_trades_log(timeframe, outcome) WHERE outcome IS NOT NULL;
