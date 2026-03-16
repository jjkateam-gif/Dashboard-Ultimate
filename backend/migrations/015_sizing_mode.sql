-- Add sizing_mode column: 'kelly' (default) or 'fixed' (no Kelly scaling)
-- When 'fixed', position size and leverage are exactly what the user sets
-- When 'kelly', mqSizeMult and optimalLev adjust based on signal quality
ALTER TABLE best_trades_settings ADD COLUMN IF NOT EXISTS sizing_mode VARCHAR(10) DEFAULT 'kelly';
