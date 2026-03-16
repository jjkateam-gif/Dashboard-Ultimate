-- Add scan_count column for deduplication tracking
-- Instead of logging duplicate signals, we increment this counter
ALTER TABLE best_trades_log ADD COLUMN IF NOT EXISTS scan_count INTEGER DEFAULT 1;
ALTER TABLE best_trades_log ADD COLUMN IF NOT EXISTS last_seen_at TIMESTAMP DEFAULT NOW();
