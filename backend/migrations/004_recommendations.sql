CREATE TABLE IF NOT EXISTS trade_recommendations (
  id SERIAL PRIMARY KEY,
  user_id INTEGER REFERENCES users(id),
  symbol VARCHAR(20) NOT NULL,
  direction VARCHAR(10) NOT NULL,
  probability NUMERIC(5,2),
  entry_price NUMERIC(20,8),
  target_price NUMERIC(20,8),
  stop_price NUMERIC(20,8),
  rr_ratio NUMERIC(5,2),
  created_at TIMESTAMP DEFAULT NOW(),
  resolved_at TIMESTAMP,
  outcome VARCHAR(10),
  actual_pnl_pct NUMERIC(8,2)
);
CREATE INDEX IF NOT EXISTS idx_recs_user ON trade_recommendations(user_id);
CREATE INDEX IF NOT EXISTS idx_recs_created ON trade_recommendations(created_at);
