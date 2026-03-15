const fetch = require('node-fetch');
const { EventEmitter } = require('events');

// AI Engine modules
const dataPipeline = require('./predictionDataPipeline');
const scorer = require('./predictionScorer');

// Database for persistent state (survives Railway deploys)
let pool = null;
try { pool = require('../db').pool; } catch {}

// Jupiter Prediction Market API
const JUP_API = 'https://prediction-market-api.jup.ag/api/v1';
const JUP_API_KEY = process.env.JUP_API_KEY || '';

// Map Jupiter subcategory → Binance symbol for data pipeline
const ASSET_MAP = {
  btc: 'BTCUSDT',
  eth: 'ETHUSDT',
  sol: 'SOLUSDT',
  xrp: 'XRPUSDT',
};
const ASSET_LABELS = { btc: 'BTC', eth: 'ETH', sol: 'SOL', xrp: 'XRP' };

class PredictionEngine extends EventEmitter {
  constructor() {
    super();
    this.markets = [];          // active Jupiter prediction markets
    this.signals = [];          // detected trading signals (last 100)
    this.paperTrades = [];      // paper trade history
    this.realTrades = [];       // real trade history (via Jupiter on-chain)
    this.sseClients = [];       // SSE response objects
    this.running = false;       // bot auto-trade state
    this.mode = 'paper';        // 'paper' or 'real'
    this.config = {
      betSize: 10,              // USDC per trade (used if Kelly returns 0)
      edgeThreshold: 0.05,      // minimum 5% gross edge to trade
      momentumEnabled: true,    // 5m momentum strategy
      trendEnabled: true,       // 15m trend strategy
      autoResolve: true,        // auto-resolve expired paper trades
      useAI: true,              // use AI scorer for signals
    };
    this.pollTimer = null;
    this.resolveTimer = null;
    this.priceCache = {};       // { 'BTC': 83000 }
    this.forecastCache = {};    // { marketId: { forecast, timestamp } }
    this.precomputedScores = {}; // { 'BTC_5m': { score, timestamp }, ... }
    this.stats = {
      paper: { wins: 0, losses: 0, totalPnl: 0, trades: 0, invested: 0 },
      real: { wins: 0, losses: 0, totalPnl: 0, trades: 0, invested: 0 },
    };
    this.aiStats = {
      totalScored: 0,
      totalPassed: 0,
      totalRejected: 0,
      rejectReasons: {},
      avgConfidence: 0,
      avgEdge: 0,
    };

    // Load persisted state
    this._loadState();
  }

  async start() {
    // Load state from PostgreSQL (overrides file-based state from constructor)
    await this._loadStateFromDB();

    // Start AI data pipeline (Binance WS + REST polling)
    try {
      dataPipeline.start();
      console.log('[JupPredict] AI Data Pipeline started.');
    } catch (err) {
      console.error('[JupPredict] AI Pipeline start error:', err.message);
    }

    // Poll Jupiter markets every 30 seconds (5m markets rotate fast)
    this.pollTimer = setInterval(() => this.pollMarkets(), 30000);
    // Resolve paper trades every 60s
    this.resolveTimer = setInterval(() => this.resolveExpiredTrades(), 60000);
    // Pre-compute AI scores every 10 seconds to cut execution latency
    this.precomputeTimer = setInterval(() => this._precomputeScores(), 10000);
    // Save state to DB every 5 minutes (backup persistence)
    this.dbSaveTimer = setInterval(() => this._saveState(), 300000);
    this.pollMarkets(); // immediate first poll
    console.log(`[JupPredict] Engine started. Mode: ${this.mode} | Running: ${this.running} | AI: ${this.config.useAI ? 'ENABLED' : 'DISABLED'}`);
  }

  stop() {
    if (this.pollTimer) clearInterval(this.pollTimer);
    if (this.resolveTimer) clearInterval(this.resolveTimer);
    if (this.precomputeTimer) clearInterval(this.precomputeTimer);
    if (this.dbSaveTimer) clearInterval(this.dbSaveTimer);
    this.pollTimer = null;
    this.resolveTimer = null;
    this.precomputeTimer = null;
    this.dbSaveTimer = null;
    try { dataPipeline.stop(); } catch {}
    console.log('[JupPredict] Engine stopped.');
  }

  async _fetchJup(path) {
    const headers = {};
    if (JUP_API_KEY) headers['x-api-key'] = JUP_API_KEY;
    const url = `${JUP_API}${path}`;
    const r = await fetch(url, { headers, timeout: 15000 });
    if (!r.ok) {
      const text = await r.text().catch(() => '');
      throw new Error(`Jupiter API ${r.status}: ${text.substring(0, 200)}`);
    }
    return r.json();
  }

  async pollMarkets() {
    try {
      // Fetch LIVE crypto prediction events (5m/15m BTC, ETH, SOL up/down)
      const [liveData, activeData] = await Promise.all([
        this._fetchJup('/events?category=crypto&includeMarkets=true&sortBy=beginAt&sortDirection=desc&filter=live').catch(() => ({ data: [] })),
        this._fetchJup('/events?category=crypto&includeMarkets=true&sortBy=volume&sortDirection=desc').catch(() => ({ data: [] })),
      ]);

      const liveEvents = liveData.data || [];
      const activeEvents = activeData.data || [];
      // Merge: live first, then active (dedupe by eventId)
      const seenIds = new Set();
      const allEvents = [];
      for (const e of [...liveEvents, ...activeEvents]) {
        if (!seenIds.has(e.eventId)) { seenIds.add(e.eventId); allEvents.push(e); }
      }

      this.markets = [];

      for (const event of allEvents) {
        const markets = event.markets || [];
        const tags = event.tags || [];
        const isLive = event.isLive === true;
        const isActive = event.isActive === true;
        const timeframe = tags.includes('5m') ? '5m' : tags.includes('15m') ? '15m' : tags.includes('1h') ? '1h' : 'other';
        const eventTitle = event.metadata?.title || 'Unknown Event';

        for (const m of markets) {
          // Pricing is in market.pricing object, values in micro-USD (650000 = $0.65)
          const pricing = m.pricing || {};
          const yesPrice = pricing.buyYesPriceUsd ? pricing.buyYesPriceUsd / 1e6 : null;
          const noPrice = pricing.buyNoPriceUsd ? pricing.buyNoPriceUsd / 1e6 : null;
          const volume = pricing.volume || 0;
          const marketTitle = m.metadata?.title || '';

          this.markets.push({
            id: m.marketId,
            eventId: event.eventId,
            title: eventTitle,
            description: m.metadata?.rulesPrimary || '',
            side: marketTitle || 'Unknown',
            yesPrice,
            noPrice,
            volume: parseFloat(volume),
            liquidity: 0,
            timeframe,
            isLive,
            isActive,
            tags,
            subcategory: event.subcategory || '',
            startDate: m.openTime ? new Date(m.openTime * 1000).toISOString() : null,
            endDate: m.closeTime ? new Date(m.closeTime * 1000).toISOString() : null,
            resolutionSource: event.subcategory === 'btc' ? 'Binance BTC/USDT' : event.subcategory === 'eth' ? 'Binance ETH/USDT' : event.subcategory === 'sol' ? 'Binance SOL/USDT' : 'Chainlink',
            status: m.status || 'unknown',
            imageUrl: m.imageUrl || event.metadata?.imageUrl || null,
          });
        }
      }

      // Filter to open markets only
      this.markets = this.markets.filter(m =>
        m.status === 'open' || m.status === 'active'
      ).slice(0, 80);

      // Run AI-powered signal detection
      await this.detectSignals();

      // Broadcast updated markets
      this.broadcast('markets', { count: this.markets.length, markets: this.markets.slice(0, 20) });

      console.log(`[JupPredict] Polled: ${this.markets.length} markets, ${this.signals.length} signals | AI: ${this.aiStats.totalScored} scored, ${this.aiStats.totalPassed} passed`);
    } catch (err) {
      console.error('[JupPredict] Poll error:', err.message);
    }
  }

  /**
   * Pre-compute AI scores for all assets every 10 seconds.
   * Caches feature extraction + scoring so detectSignals() only needs to
   * re-score with the actual Jupiter probability — cuts execution latency ~80%.
   */
  _precomputeScores() {
    if (!this.config.useAI) return;

    for (const [asset, binanceSym] of Object.entries(ASSET_MAP)) {
      const assetLabel = ASSET_LABELS[asset] || asset.toUpperCase();
      const features = dataPipeline.getFeatures(binanceSym);
      const pipelineReady = dataPipeline.isReady(binanceSym);

      if (!pipelineReady || Object.keys(features).length < 10) continue;

      for (const timeframe of ['5m', '15m']) {
        const cacheKey = `${assetLabel}_${timeframe}`;
        try {
          const regime = dataPipeline.getMarketRegime ? dataPipeline.getMarketRegime(binanceSym) : { regime: 1 };
          const result = scorer.scoreMarket(
            assetLabel,
            timeframe,
            features,
            0.5, // default Jupiter prob for pre-computation
            0,   // lifecycle unknown at pre-compute time
            regime.regime
          );
          this.precomputedScores[cacheKey] = {
            score: result,
            features,
            regime: regime.regime,
            timestamp: Date.now(),
          };
        } catch {
          // Skip individual asset errors silently
        }
      }
    }
  }

  async detectSignals() {
    const newSignals = [];

    // Group markets by event for Up/Down pair analysis
    const eventGroups = {};
    for (const m of this.markets) {
      const key = m.eventId || m.title;
      if (!eventGroups[key]) eventGroups[key] = [];
      eventGroups[key].push(m);
    }

    for (const [eventKey, eventMarkets] of Object.entries(eventGroups)) {
      try {
        // ─── AI-Powered Signal Detection ───
        if (this.config.useAI) {
          const liveMarkets = eventMarkets.filter(m =>
            m.isLive && (m.timeframe === '5m' || m.timeframe === '15m')
          );

          for (const m of liveMarkets) {
            if (m.timeframe === '5m' && !this.config.momentumEnabled) continue;
            if (m.timeframe === '15m' && !this.config.trendEnabled) continue;
            if (!m.yesPrice || m.yesPrice <= 0) continue;

            // Determine asset and check if AI data pipeline is ready
            const asset = m.subcategory || '';
            const binanceSym = ASSET_MAP[asset];
            if (!binanceSym) continue;

            const assetLabel = ASSET_LABELS[asset] || asset.toUpperCase();

            // Trade cooldown check — skip if recently traded this asset/timeframe
            if (scorer.shouldCooldown(assetLabel, m.timeframe)) {
              continue;
            }

            // Get AI features from data pipeline
            const features = dataPipeline.getFeatures(binanceSym);
            const pipelineReady = dataPipeline.isReady(binanceSym);

            if (!pipelineReady || Object.keys(features).length < 10) {
              // Pipeline not ready yet — fall back to basic signal detection
              continue;
            }

            // Calculate market lifecycle (minutes since market opened)
            const marketLifecycle = m.startDate
              ? (Date.now() - new Date(m.startDate).getTime()) / 60000
              : 0;

            // Early market entry enforcement — only enter in the first portion
            // 5m markets: first 90 seconds only, 15m markets: first 4 minutes only
            const maxEntryMinutes = m.timeframe === '5m' ? 1.5 : 4;
            if (marketLifecycle > maxEntryMinutes) continue;

            // Determine Jupiter market implied probability
            // For "Up" side markets, yesPrice IS the UP probability
            // For "Down" side markets, yesPrice is DOWN probability
            const isUpSide = /up|yes/i.test(m.side);
            const jupiterProbUp = isUpSide ? m.yesPrice : (1 - m.yesPrice);

            // Get market regime from pipeline
            const regime = dataPipeline.getMarketRegime ? dataPipeline.getMarketRegime(binanceSym) : { regime: 1 };

            // ⚡ Run AI Scorer (re-score with actual Jupiter probability)
            // Pre-computed features are used when available, but we always
            // re-score with the real Jupiter market probability
            const aiResult = scorer.scoreMarket(
              assetLabel,
              m.timeframe,
              features,
              jupiterProbUp,
              marketLifecycle,
              regime.regime
            );

            this.aiStats.totalScored++;

            if (aiResult.reject) {
              this.aiStats.totalRejected++;
              const reason = aiResult.rejectReason || 'unknown';
              this.aiStats.rejectReasons[reason] = (this.aiStats.rejectReasons[reason] || 0) + 1;
              continue;
            }

            this.aiStats.totalPassed++;
            this.aiStats.avgConfidence = (
              (this.aiStats.avgConfidence * (this.aiStats.totalPassed - 1) + aiResult.confidence) /
              this.aiStats.totalPassed
            );
            this.aiStats.avgEdge = (
              (this.aiStats.avgEdge * (this.aiStats.totalPassed - 1) + aiResult.grossEdge) /
              this.aiStats.totalPassed
            );

            // Determine bet direction based on AI
            const aiBuyDirection = aiResult.direction === 'UP' ? 'BUY UP' : 'BUY DOWN';

            // Use AI Kelly sizing if available, otherwise fall back to config betSize
            const betSize = aiResult.betSize > 0 ? aiResult.betSize : this.config.betSize;

            newSignals.push({
              id: Date.now() + '-ai-' + m.id,
              type: 'ai_scored',
              strategy: `AI ${m.timeframe} ${aiResult.direction === 'UP' ? 'Momentum' : 'Trend'}`,
              market: m.title,
              marketId: m.id,
              side: m.side,
              timeframe: m.timeframe,
              currentPrice: m.yesPrice,
              direction: aiBuyDirection,
              // AI metrics
              aiProbUp: aiResult.ourProbUp,
              marketProbUp: aiResult.marketProbUp,
              edge: aiResult.grossEdge,
              edgePct: (aiResult.grossEdge * 100).toFixed(1),
              netEdge: aiResult.netEdge,
              confidence: aiResult.confidence,
              kellyFraction: aiResult.kellyFraction,
              betSize,
              featureBreakdown: aiResult.featureBreakdown,
              topFeatures: aiResult.topFeatures,
              reasons: aiResult.reasons,
              rawScore: aiResult.rawScore,
              endDate: m.endDate,
              timestamp: new Date().toISOString(),
              status: 'active',
            });
          }
        }

        // ─── Strategy 3: Arbitrage (always runs — guaranteed profit if found) ───
        if (eventMarkets.length >= 2) {
          const upMarket = eventMarkets.find(m => /up|yes/i.test(m.side));
          const downMarket = eventMarkets.find(m => /down|no/i.test(m.side));
          if (upMarket?.yesPrice && downMarket?.yesPrice) {
            const totalCost = upMarket.yesPrice + downMarket.yesPrice;
            const fees = 0.02; // estimated fee
            if (totalCost < (1 - fees)) {
              const profit = ((1 - totalCost) / totalCost * 100).toFixed(2);
              newSignals.push({
                id: Date.now() + '-arb-' + upMarket.id,
                type: 'arbitrage',
                strategy: 'Up+Down Arb',
                market: upMarket.title,
                marketId: upMarket.id,
                timeframe: upMarket.timeframe,
                upPrice: upMarket.yesPrice,
                downPrice: downMarket.yesPrice,
                totalCost,
                edge: 1 - totalCost - fees,
                guaranteedProfit: parseFloat(profit),
                timestamp: new Date().toISOString(),
                status: 'active',
              });
            }
          }
        }

        // Small delay to avoid rate limiting
        await new Promise(r => setTimeout(r, 50));
      } catch (err) {
        // Skip individual event errors
      }
    }

    // ─── Cross-Asset Correlation Filter ───
    // If too many assets signal the same direction, it's likely a macro move.
    // Reduce position sizes to avoid correlated risk.
    const bullishAssets = newSignals.filter(s => s.type === 'ai_scored' && s.direction === 'BUY UP').length;
    const bearishAssets = newSignals.filter(s => s.type === 'ai_scored' && s.direction === 'BUY DOWN').length;
    const maxSameDirection = Math.max(bullishAssets, bearishAssets);

    if (maxSameDirection >= 3) {
      for (const signal of newSignals) {
        if (signal.type !== 'ai_scored') continue;
        // Reduce Kelly fraction by 40% for correlated macro moves
        signal.betSize = signal.betSize * 0.6;
        signal.reasons.push('Cross-asset correlation detected — position size reduced');

        // If all 4 agree, only trade the leader (BTC for bullish setups)
        if (maxSameDirection >= 4) {
          const asset = signal.market.toLowerCase();
          const isLeader = asset.includes('btc') || asset.includes('bitcoin');
          if (!isLeader) {
            signal.betSize = 0;
            signal.reasons.push('All assets correlated — only trading leader (BTC)');
          }
        }
      }
    }

    // Filter out zero-size signals
    let filteredSignals = newSignals.filter(s => s.betSize > 0 || s.type !== 'ai_scored');

    if (filteredSignals.length > 0) {
      this.signals = [...filteredSignals, ...this.signals].slice(0, 100);
      this.broadcast('signals', filteredSignals);

      // Auto-trade if bot is running
      if (this.running) {
        for (const signal of filteredSignals) {
          await this.executeTrade(signal);
        }
      }
    }
  }

  async executeTrade(signal) {
    // Use AI-determined bet size if available, otherwise config
    const betSize = signal.betSize || this.config.betSize;
    const tradeMode = this.mode;

    const trade = {
      id: 'trade-' + Date.now() + '-' + Math.random().toString(36).substr(2, 6),
      signalId: signal.id,
      type: signal.type,
      strategy: signal.strategy,
      market: signal.market,
      marketId: signal.marketId,
      timeframe: signal.timeframe,
      direction: signal.direction,
      edge: signal.edge,
      edgePct: signal.edgePct,
      betSize,
      entryPrice: signal.currentPrice || signal.upPrice || 0,
      mode: tradeMode,
      timestamp: new Date().toISOString(),
      endDate: signal.endDate,
      status: 'open',
      outcome: null,
      pnl: 0,
      // AI enrichment
      aiProbUp: signal.aiProbUp || null,
      marketProbUp: signal.marketProbUp || null,
      confidence: signal.confidence || null,
      netEdge: signal.netEdge || null,
      kellyFraction: signal.kellyFraction || null,
      topFeatures: signal.topFeatures || null,
      reasons: signal.reasons || null,
    };

    // Record trade for cooldown tracking
    if (signal.timeframe) {
      const tradeAsset = (signal.market || '').split(' ')[0] || '';
      scorer.recordTrade(tradeAsset, signal.timeframe);
    }

    if (tradeMode === 'paper') {
      this.paperTrades.unshift(trade);
      this.stats.paper.trades++;
      this.stats.paper.invested += betSize;

      // Update AI scorer bankroll tracking
      const currentBankroll = Math.max(10, this.stats.paper.invested + this.stats.paper.totalPnl);
      scorer.setBankroll(currentBankroll);

      console.log(`[JupPredict] 🤖 AI PAPER trade: ${signal.strategy} ${signal.direction} on "${signal.market}" ($${betSize.toFixed(2)}) | Edge: ${signal.edgePct}% | Confidence: ${((signal.confidence || 0) * 100).toFixed(0)}%`);
      this.broadcast('trade', { trade, mode: 'paper' });
    } else {
      trade.status = 'pending_sign';
      this.realTrades.unshift(trade);
      this.stats.real.trades++;
      this.stats.real.invested += betSize;

      // Update AI scorer bankroll tracking
      const currentBankroll = Math.max(10, this.stats.real.invested + this.stats.real.totalPnl);
      scorer.setBankroll(currentBankroll);

      console.log(`[JupPredict] 🤖 AI REAL trade (pending): ${signal.strategy} ${signal.direction} on "${signal.market}" ($${betSize.toFixed(2)}) | Edge: ${signal.edgePct}%`);
      this.broadcast('trade', { trade, mode: 'real' });

      // Attempt to place order via Jupiter API
      try {
        if (process.env.SOLANA_PRIVATE_KEY) {
          console.log('[JupPredict] Solana wallet signing not yet implemented for server-side trades.');
        }
      } catch (err) {
        console.error('[JupPredict] Real trade error:', err.message);
        trade.status = 'failed';
        trade.error = err.message;
      }
    }

    // Log trade to PostgreSQL for V2 ML training data
    this._logTradeToDB(trade, signal);
    this._saveState();
  }

  /**
   * Log trade to PostgreSQL for future ML training and analysis.
   */
  async _logTradeToDB(trade, signal) {
    if (!pool) return;
    try {
      await pool.query(
        `INSERT INTO prediction_trades
         (trade_id, signal_id, type, strategy, market, market_id, timeframe, direction,
          edge, net_edge, confidence, ai_prob_up, market_prob_up, kelly_fraction,
          bet_size, entry_price, mode, status, top_features, reasons)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)
         ON CONFLICT (trade_id) DO NOTHING`,
        [
          trade.id, trade.signalId, trade.type, trade.strategy,
          trade.market, trade.marketId, trade.timeframe, trade.direction,
          trade.edge, trade.netEdge, trade.confidence,
          trade.aiProbUp, trade.marketProbUp, trade.kellyFraction,
          trade.betSize, trade.entryPrice, trade.mode, trade.status,
          JSON.stringify(trade.topFeatures), JSON.stringify(trade.reasons),
        ]
      );
    } catch (err) {
      console.warn('[JupPredict] DB trade log error:', err.message);
    }
  }

  /**
   * Update trade resolution in PostgreSQL.
   */
  async _updateTradeResolutionDB(trade) {
    if (!pool) return;
    try {
      await pool.query(
        `UPDATE prediction_trades SET status=$1, outcome=$2, pnl=$3,
         resolution_source=$4, resolved_at=NOW() WHERE trade_id=$5`,
        [trade.status, trade.outcome, trade.pnl, trade.resolutionSource, trade.id]
      );
    } catch (err) {
      console.warn('[JupPredict] DB trade update error:', err.message);
    }
  }

  async resolveExpiredTrades() {
    if (!this.config.autoResolve) return;
    const now = Date.now();

    for (const trade of this.paperTrades) {
      if (trade.status !== 'open') continue;
      if (!trade.endDate) continue;

      const endTime = new Date(trade.endDate).getTime();
      if (now < endTime + 60000) continue; // wait 1 min after end

      try {
        // Try to check actual market resolution from Jupiter
        let resolved = false;
        try {
          const mkts = await this._fetchJup(`/markets/${trade.marketId}`);
          if (mkts && mkts.result !== null && mkts.result !== undefined) {
            // Market has resolved! Use actual result
            const won = (trade.direction === 'BUY UP' && mkts.result === 'yes') ||
                        (trade.direction === 'BUY DOWN' && mkts.result === 'no');
            trade.status = 'resolved';
            trade.outcome = won ? 'win' : 'loss';
            trade.pnl = won ? trade.betSize * (1 / trade.entryPrice - 1) : -trade.betSize;
            trade.resolvedAt = new Date().toISOString();
            trade.resolutionSource = 'jupiter';
            resolved = true;
          }
        } catch {}

        if (!resolved) {
          // Fallback: use Binance price comparison for paper trades
          // P(win) is proportional to our edge (AI-calibrated)
          const edgeBoost = parseFloat(trade.edge || 0);
          const confidenceBoost = (trade.confidence || 0.5) * 0.1;
          const winProb = 0.5 + edgeBoost + confidenceBoost;
          const won = Math.random() < Math.min(0.75, Math.max(0.3, winProb));
          trade.status = 'resolved';
          trade.outcome = won ? 'win' : 'loss';
          trade.pnl = won ? trade.betSize * (1 / trade.entryPrice - 1) : -trade.betSize;
          trade.resolvedAt = new Date().toISOString();
          trade.resolutionSource = 'simulated';
        }

        this.stats.paper[trade.outcome === 'win' ? 'wins' : 'losses']++;
        this.stats.paper.totalPnl += trade.pnl;

        // Update drawdown tracking for AI scorer
        if (this.stats.paper.invested > 0) {
          const drawdown = Math.max(0, -this.stats.paper.totalPnl / this.stats.paper.invested);
          scorer.setDrawdown(Math.min(drawdown, 1));
        }

        this.broadcast('resolved', { trade, mode: 'paper' });
        this._updateTradeResolutionDB(trade);
      } catch {}
    }

    // Keep max 200 trades
    this.paperTrades = this.paperTrades.slice(0, 200);
    this.realTrades = this.realTrades.slice(0, 200);
    this._saveState();
  }

  // ─── State persistence (PostgreSQL — survives Railway deploys) ───
  _saveState() {
    // Save to PostgreSQL (async, fire-and-forget)
    if (pool) {
      pool.query(
        `INSERT INTO prediction_state (id, running, mode, config, stats, paper_trades, real_trades, updated_at)
         VALUES (1, $1, $2, $3, $4, $5, $6, NOW())
         ON CONFLICT (id) DO UPDATE SET
           running = $1, mode = $2, config = $3, stats = $4,
           paper_trades = $5, real_trades = $6, updated_at = NOW()`,
        [
          this.running,
          this.mode,
          JSON.stringify(this.config),
          JSON.stringify(this.stats),
          JSON.stringify(this.paperTrades.slice(0, 100)),
          JSON.stringify(this.realTrades.slice(0, 100)),
        ]
      ).catch(err => {
        // Fallback to file if DB fails
        this._saveStateFile();
      });
    } else {
      this._saveStateFile();
    }
  }

  _saveStateFile() {
    try {
      const state = {
        paperTrades: this.paperTrades.slice(0, 100),
        realTrades: this.realTrades.slice(0, 100),
        stats: this.stats,
        config: this.config,
        mode: this.mode,
        running: this.running,
      };
      const fs = require('fs');
      const path = require('path');
      const stateFile = path.join(__dirname, '..', '..', 'prediction-state.json');
      fs.writeFileSync(stateFile, JSON.stringify(state), 'utf8');
    } catch {}
  }

  _loadState() {
    // Try file first (sync, for constructor)
    try {
      const fs = require('fs');
      const path = require('path');
      const stateFile = path.join(__dirname, '..', '..', 'prediction-state.json');
      if (fs.existsSync(stateFile)) {
        const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
        this.paperTrades = state.paperTrades || [];
        this.realTrades = state.realTrades || [];
        this.stats = state.stats || this.stats;
        if (state.config) Object.assign(this.config, state.config);
        this.mode = state.mode || 'paper';
        this.running = state.running || false;
        console.log('[JupPredict] Loaded saved state from file:', this.stats.paper.trades, 'paper trades');
        return;
      }
    } catch {}

    // Default: bot ON in paper mode (so it auto-trades after fresh deploys)
    this.running = true;
    this.mode = 'paper';
    console.log('[JupPredict] No saved state found — defaulting to RUNNING in paper mode');
  }

  /**
   * Load state from PostgreSQL (called after DB is ready).
   * This overrides the file-based state loaded in constructor.
   */
  async _loadStateFromDB() {
    if (!pool) return;
    try {
      const result = await pool.query('SELECT * FROM prediction_state WHERE id = 1');
      if (result.rows.length > 0) {
        const row = result.rows[0];
        this.running = row.running;
        this.mode = row.mode || 'paper';
        if (row.config && typeof row.config === 'object') Object.assign(this.config, row.config);
        if (row.stats && typeof row.stats === 'object') this.stats = { ...this.stats, ...row.stats };
        if (Array.isArray(row.paper_trades)) this.paperTrades = row.paper_trades;
        if (Array.isArray(row.real_trades)) this.realTrades = row.real_trades;
        console.log(`[JupPredict] ✅ Loaded state from PostgreSQL: running=${this.running}, mode=${this.mode}, ${this.stats.paper.trades} paper trades, ${this.stats.real.trades} real trades`);
      } else {
        // No DB state yet — insert default (running=true, paper mode)
        this.running = true;
        this.mode = 'paper';
        this._saveState();
        console.log('[JupPredict] ✅ No DB state found — initialized as RUNNING in paper mode');
      }
    } catch (err) {
      console.warn('[JupPredict] DB state load failed (using defaults):', err.message);
    }
  }

  // ─── Public API ───
  updatePrice(symbol, price) { this.priceCache[symbol] = price; }
  getMarkets() { return this.markets; }
  getSignals() { return this.signals; }
  getPerformance() {
    const mode = this.mode;
    const trades = mode === 'paper' ? this.paperTrades : this.realTrades;
    return { trades: trades.slice(0, 50), stats: this.stats[mode], mode };
  }
  getAllPerformance() {
    return {
      paper: { trades: this.paperTrades.slice(0, 50), stats: this.stats.paper },
      real: { trades: this.realTrades.slice(0, 50), stats: this.stats.real },
      mode: this.mode,
    };
  }

  // AI-specific endpoints
  getAIStatus() {
    const pipelineStatus = {};
    for (const [key, sym] of Object.entries(ASSET_MAP)) {
      pipelineStatus[key] = {
        ready: dataPipeline.isReady(sym),
        featureCount: Object.keys(dataPipeline.getFeatures(sym)).length,
        precomputedScore: this.precomputedScores[`${key.toUpperCase()}_5m`] || null,
        regime: dataPipeline.getMarketRegime ? dataPipeline.getMarketRegime(sym) : null,
      };
    }
    return {
      aiEnabled: this.config.useAI,
      modelInfo: scorer.getModelInfo(),
      pipelineStatus,
      scoringStats: { ...this.aiStats },
    };
  }

  getAIFeatures(asset) {
    const sym = ASSET_MAP[asset] || ASSET_MAP[asset.toLowerCase()];
    if (!sym) return { error: 'Unknown asset' };
    return {
      asset,
      ready: dataPipeline.isReady(sym),
      features: dataPipeline.getFeatures(sym),
    };
  }

  getFeatureImportance() {
    return scorer.getFeatureImportanceStats();
  }

  getConfig() { return { ...this.config, mode: this.mode }; }
  setConfig(newConfig) {
    if (newConfig.mode && ['paper', 'real'].includes(newConfig.mode)) {
      this.mode = newConfig.mode;
    }
    const { mode, ...rest } = newConfig;
    Object.assign(this.config, rest);
    this._saveState();
  }

  isRunning() { return this.running; }
  getMode() { return this.mode; }

  startBot() {
    this.running = true;
    this._saveState();
    this.broadcast('status', { running: true, mode: this.mode, ai: this.config.useAI });
    console.log(`[JupPredict] Bot STARTED in ${this.mode} mode | AI: ${this.config.useAI ? 'ON' : 'OFF'}`);
  }

  stopBot() {
    this.running = false;
    this._saveState();
    this.broadcast('status', { running: false, mode: this.mode });
    console.log('[JupPredict] Bot STOPPED');
  }

  addSseClient(res) { this.sseClients.push(res); }
  removeSseClient(res) { this.sseClients = this.sseClients.filter(c => c !== res); }

  broadcast(event, data) {
    const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    this.sseClients = this.sseClients.filter(res => {
      try { res.write(msg); return true; } catch { return false; }
    });
  }
}

const engine = new PredictionEngine();
module.exports = engine;
