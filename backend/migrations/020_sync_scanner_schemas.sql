-- Sync stock_trades_log and commodity_trades_log schemas with best_trades_log
-- These columns were added to best_trades_log in migrations 016-019 but never added to stock/commodity tables

-- Stock scanner: add missing columns
ALTER TABLE stock_trades_log ADD COLUMN IF NOT EXISTS engine_source VARCHAR(30);
ALTER TABLE stock_trades_log ADD COLUMN IF NOT EXISTS data_source VARCHAR(20) DEFAULT 'signal_log';
ALTER TABLE stock_trades_log ADD COLUMN IF NOT EXISTS exit_reason VARCHAR(20);
ALTER TABLE stock_trades_log ADD COLUMN IF NOT EXISTS hours_open DECIMAL(10,2);
ALTER TABLE stock_trades_log ADD COLUMN IF NOT EXISTS closed_at TIMESTAMPTZ;
ALTER TABLE stock_trades_log ADD COLUMN IF NOT EXISTS mae_pct DECIMAL(10,4);
ALTER TABLE stock_trades_log ADD COLUMN IF NOT EXISTS mfe_pct DECIMAL(10,4);
ALTER TABLE stock_trades_log ADD COLUMN IF NOT EXISTS hours_to_resolution DECIMAL(10,2);

-- Commodity scanner: add missing columns
ALTER TABLE commodity_trades_log ADD COLUMN IF NOT EXISTS engine_source VARCHAR(30);
ALTER TABLE commodity_trades_log ADD COLUMN IF NOT EXISTS data_source VARCHAR(20) DEFAULT 'signal_log';
ALTER TABLE commodity_trades_log ADD COLUMN IF NOT EXISTS exit_reason VARCHAR(20);
ALTER TABLE commodity_trades_log ADD COLUMN IF NOT EXISTS hours_open DECIMAL(10,2);
ALTER TABLE commodity_trades_log ADD COLUMN IF NOT EXISTS closed_at TIMESTAMPTZ;
ALTER TABLE commodity_trades_log ADD COLUMN IF NOT EXISTS mae_pct DECIMAL(10,4);
ALTER TABLE commodity_trades_log ADD COLUMN IF NOT EXISTS mfe_pct DECIMAL(10,4);
ALTER TABLE commodity_trades_log ADD COLUMN IF NOT EXISTS hours_to_resolution DECIMAL(10,2);
