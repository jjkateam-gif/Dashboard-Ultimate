-- #15: Per-trade gate decision logging
-- Stores structured JSON array of gate pass/block decisions for each trade signal
ALTER TABLE best_trades_log ADD COLUMN IF NOT EXISTS gate_decisions JSONB;

COMMENT ON COLUMN best_trades_log.gate_decisions IS 'Array of {gate, result, detail} objects tracking which gates passed/blocked this signal';
