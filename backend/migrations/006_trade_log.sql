-- Add source tracking and context columns to trade_recommendations
ALTER TABLE trade_recommendations ADD COLUMN IF NOT EXISTS source VARCHAR(10) DEFAULT 'auto';
ALTER TABLE trade_recommendations ADD COLUMN IF NOT EXISTS timeframe VARCHAR(10);
ALTER TABLE trade_recommendations ADD COLUMN IF NOT EXISTS confidence VARCHAR(10);
ALTER TABLE trade_recommendations ADD COLUMN IF NOT EXISTS leverage INTEGER DEFAULT 1;
ALTER TABLE trade_recommendations ADD COLUMN IF NOT EXISTS mode VARCHAR(10) DEFAULT 'spot';

-- Index for filtering by source
CREATE INDEX IF NOT EXISTS idx_recs_source ON trade_recommendations(source);
