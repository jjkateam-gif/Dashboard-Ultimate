-- Prediction engine state persistence (survives Railway deploys)
CREATE TABLE IF NOT EXISTS prediction_state (
  id INTEGER PRIMARY KEY DEFAULT 1,
  running BOOLEAN NOT NULL DEFAULT true,
  mode VARCHAR(10) NOT NULL DEFAULT 'paper',
  config JSONB NOT NULL DEFAULT '{}',
  stats JSONB NOT NULL DEFAULT '{}',
  paper_trades JSONB NOT NULL DEFAULT '[]',
  real_trades JSONB NOT NULL DEFAULT '[]',
  updated_at TIMESTAMP DEFAULT NOW(),
  CONSTRAINT single_row CHECK (id = 1)
);

-- Insert default state (bot ON by default in paper mode)
INSERT INTO prediction_state (id, running, mode, config, stats, paper_trades, real_trades)
VALUES (1, true, 'paper', '{}', '{}', '[]', '[]')
ON CONFLICT (id) DO NOTHING;

-- Prediction trade log for V2 ML training data
CREATE TABLE IF NOT EXISTS prediction_trades (
  id SERIAL PRIMARY KEY,
  trade_id VARCHAR(100) UNIQUE NOT NULL,
  signal_id VARCHAR(100),
  type VARCHAR(20),
  strategy VARCHAR(100),
  market VARCHAR(200),
  market_id VARCHAR(100),
  timeframe VARCHAR(10),
  direction VARCHAR(20),
  edge DECIMAL(10,6),
  net_edge DECIMAL(10,6),
  confidence DECIMAL(10,6),
  ai_prob_up DECIMAL(10,6),
  market_prob_up DECIMAL(10,6),
  kelly_fraction DECIMAL(10,6),
  bet_size DECIMAL(10,2),
  entry_price DECIMAL(10,6),
  mode VARCHAR(10),
  status VARCHAR(20) DEFAULT 'open',
  outcome VARCHAR(10),
  pnl DECIMAL(10,4),
  resolution_source VARCHAR(20),
  top_features JSONB,
  reasons JSONB,
  feature_snapshot JSONB,
  created_at TIMESTAMP DEFAULT NOW(),
  resolved_at TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_prediction_trades_status ON prediction_trades(status);
CREATE INDEX IF NOT EXISTS idx_prediction_trades_mode ON prediction_trades(mode);
CREATE INDEX IF NOT EXISTS idx_prediction_trades_created ON prediction_trades(created_at);
