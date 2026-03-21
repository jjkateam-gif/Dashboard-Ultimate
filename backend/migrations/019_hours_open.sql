-- Migration 019: Add closed_at and hours_open to best_trades_log for trade duration tracking

ALTER TABLE best_trades_log ADD COLUMN IF NOT EXISTS closed_at TIMESTAMPTZ;
ALTER TABLE best_trades_log ADD COLUMN IF NOT EXISTS hours_open DECIMAL(10,2);

CREATE INDEX IF NOT EXISTS idx_bt_log_closed_at ON best_trades_log(closed_at);
