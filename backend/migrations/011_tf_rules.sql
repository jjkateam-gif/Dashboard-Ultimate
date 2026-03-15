-- Per-timeframe auto-trade rules (JSONB column)
-- Allows different minProb, minQuality per timeframe
-- Example: {"5m": {"enabled": true, "minProb": 60, "minQuality": "B"}, "4h": {"enabled": false}}
ALTER TABLE best_trades_settings ADD COLUMN IF NOT EXISTS tf_rules JSONB DEFAULT '{}';
