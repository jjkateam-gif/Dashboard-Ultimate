-- Migration: Replace Jupiter/Drift with BloFin
-- The trading_wallets table is repurposed for BloFin API credentials
-- (encrypted_data column already stores encrypted JSON)

-- Update protocol defaults
ALTER TABLE live_strategies ALTER COLUMN protocol SET DEFAULT 'blofin';
UPDATE live_strategies SET protocol = 'blofin' WHERE protocol IN ('jupiter', 'drift');

-- Update existing records
UPDATE live_positions SET protocol = 'blofin' WHERE protocol IN ('jupiter', 'drift');
UPDATE live_trade_history SET protocol = 'blofin' WHERE protocol IN ('jupiter', 'drift');

-- Add new columns for BloFin-specific data
ALTER TABLE live_positions ADD COLUMN IF NOT EXISTS order_id VARCHAR(64);
ALTER TABLE live_positions ADD COLUMN IF NOT EXISTS margin_mode VARCHAR(10) DEFAULT 'cross';
ALTER TABLE live_trade_history ADD COLUMN IF NOT EXISTS order_id VARCHAR(64);

-- Widen market column to support BloFin instIds (e.g. 'BTC-USDT')
ALTER TABLE live_positions ALTER COLUMN market TYPE VARCHAR(30);
ALTER TABLE live_trade_history ALTER COLUMN market TYPE VARCHAR(30);
