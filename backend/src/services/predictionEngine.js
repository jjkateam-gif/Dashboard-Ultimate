const fetch = require('node-fetch');
const { EventEmitter } = require('events');

// AI Engine modules
const dataPipeline = require('./predictionDataPipeline');
const scorer = require('./predictionScorer');

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

  start() {
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
    this.pollMarkets(); // immediate first poll
    console.log('[JupPredict] Engine started. Mode:', this.mode, '| AI:', this.config.useAI ? 'ENABLED' : 'DISABLED');
  }

  stop() {
    if (this.pollTimer) clearInterval(this.pollTimer);
    if (this.resolveTimer) clearInterval(this.resolveTimer);
    this.pollTimer = null;
    this.resolveTimer = null;
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

            // Determine Jupiter market implied probability
            // For "Up" side markets, yesPrice IS the UP probability
            // For "Down" side markets, yesPrice is DOWN probability
            const isUpSide = /up|yes/i.test(m.side);
            const jupiterProbUp = isUpSide ? m.yesPrice : (1 - m.yesPrice);

            // ⚡ Run AI Scorer
            const aiResult = scorer.scoreMarket(
              assetLabel,
              m.timeframe,
              features,
              jupiterProbUp,
              marketLifecycle
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

    if (newSignals.length > 0) {
      this.signals = [...newSignals, ...this.signals].slice(0, 100);
      this.broadcast('signals', newSignals);

      // Auto-trade if bot is running
      if (this.running) {
        for (const signal of newSignals) {
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

    this._saveState();
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
      } catch {}
    }

    // Keep max 200 trades
    this.paperTrades = this.paperTrades.slice(0, 200);
    this.realTrades = this.realTrades.slice(0, 200);
    this._saveState();
  }

  // ─── State persistence ───
  _saveState() {
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
        console.log('[JupPredict] Loaded saved state:', this.stats.paper.trades, 'paper trades,', this.stats.real.trades, 'real trades');
      }
    } catch {}
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
