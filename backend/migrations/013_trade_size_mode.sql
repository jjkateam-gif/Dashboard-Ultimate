-- Add trade_size_mode column to best_trades_settings
-- Supports 'fixed' (dollar amount) or 'percent' (% of wallet balance)
ALTER TABLE best_trades_settings ADD COLUMN IF NOT EXISTS trade_size_mode VARCHAR(10) DEFAULT 'fixed';
