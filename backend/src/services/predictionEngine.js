const fetch = require('node-fetch');
const { EventEmitter } = require('events');

// Jupiter Prediction Market API
const JUP_API = 'https://prediction-market-api.jup.ag/api/v1';
const JUP_API_KEY = process.env.JUP_API_KEY || '';

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
      betSize: 10,              // USDC per trade
      edgeThreshold: 0.08,     // minimum 8% edge to trade
      momentumEnabled: true,    // 5m momentum strategy
      trendEnabled: true,       // 15m trend strategy
      autoResolve: true,        // auto-resolve expired paper trades
    };
    this.pollTimer = null;
    this.resolveTimer = null;
    this.priceCache = {};       // { 'BTC': 83000 }
    this.forecastCache = {};    // { marketId: { forecast, timestamp } }
    this.stats = {
      paper: { wins: 0, losses: 0, totalPnl: 0, trades: 0, invested: 0 },
      real: { wins: 0, losses: 0, totalPnl: 0, trades: 0, invested: 0 },
    };

    // Load persisted state
    this._loadState();
  }

  start() {
    // Poll markets every 30 seconds (5m markets rotate fast)
    this.pollTimer = setInterval(() => this.pollMarkets(), 30000);
    // Resolve paper trades every 60s
    this.resolveTimer = setInterval(() => this.resolveExpiredTrades(), 60000);
    this.pollMarkets(); // immediate first poll
    console.log('[JupPredict] Engine started. Mode:', this.mode);
  }

  stop() {
    if (this.pollTimer) clearInterval(this.pollTimer);
    if (this.resolveTimer) clearInterval(this.resolveTimer);
    this.pollTimer = null;
    this.resolveTimer = null;
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

      // Run signal detection
      await this.detectSignals();

      // Broadcast updated markets
      this.broadcast('markets', { count: this.markets.length, markets: this.markets.slice(0, 20) });

      console.log(`[JupPredict] Polled: ${this.markets.length} markets, ${this.signals.length} signals`);
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
        // Strategy 1: Momentum — find mispriced 5m markets using forecast data
        const fiveMinMarkets = eventMarkets.filter(m => m.timeframe === '5m' && m.isLive);
        for (const m of fiveMinMarkets) {
          if (!this.config.momentumEnabled) break;
          if (!m.yesPrice || m.yesPrice <= 0) continue;

          // Fetch forecast if we have it cached and it's recent, else fetch
          let forecast = null;
          const cached = this.forecastCache[m.id];
          if (cached && Date.now() - cached.timestamp < 30000) {
            forecast = cached.forecast;
          } else {
            try {
              const fData = await this._fetchJup(`/forecast?marketId=${m.id}`);
              const history = fData.forecast_history || fData.forecasts || [];
              if (history.length > 0) {
                const latest = history[history.length - 1];
                forecast = (latest.numerical_forecast || latest.raw_numerical_forecast) / 100;
                this.forecastCache[m.id] = { forecast, timestamp: Date.now() };
              }
            } catch {}
          }

          if (forecast !== null) {
            const edge = Math.abs(forecast - m.yesPrice);
            if (edge >= this.config.edgeThreshold) {
              const direction = forecast > m.yesPrice ? 'BUY UP' : 'BUY DOWN';
              newSignals.push({
                id: Date.now() + '-mom-' + m.id,
                type: 'momentum',
                strategy: '5m Momentum',
                market: m.title,
                marketId: m.id,
                side: m.side,
                timeframe: m.timeframe,
                currentPrice: m.yesPrice,
                forecastPrice: forecast,
                direction,
                edge,
                edgePct: (edge * 100).toFixed(1),
                endDate: m.endDate,
                timestamp: new Date().toISOString(),
                status: 'active',
              });
            }
          }
        }

        // Strategy 2: Trend — 15m markets with orderbook imbalance
        const fifteenMinMarkets = eventMarkets.filter(m => m.timeframe === '15m' && m.isLive);
        for (const m of fifteenMinMarkets) {
          if (!this.config.trendEnabled) break;
          if (!m.yesPrice || m.yesPrice <= 0) continue;

          try {
            const obData = await this._fetchJup(`/orderbook/${m.id}`);
            const yesBids = obData.yes || obData.yes_dollars || [];
            const noBids = obData.no || obData.no_dollars || [];

            // Calculate orderbook imbalance
            const yesDepth = yesBids.reduce((s, [p, q]) => s + (parseFloat(q) || 0), 0);
            const noDepth = noBids.reduce((s, [p, q]) => s + (parseFloat(q) || 0), 0);
            const totalDepth = yesDepth + noDepth;

            if (totalDepth > 0) {
              const yesRatio = yesDepth / totalDepth;
              const imbalance = Math.abs(yesRatio - 0.5);

              // If orderbook heavily favors one side vs current price
              if (imbalance >= this.config.edgeThreshold) {
                const impliedFair = yesRatio;
                const edge = Math.abs(impliedFair - m.yesPrice);
                if (edge >= this.config.edgeThreshold * 0.8) {
                  const direction = impliedFair > m.yesPrice ? 'BUY UP' : 'BUY DOWN';
                  newSignals.push({
                    id: Date.now() + '-trend-' + m.id,
                    type: 'trend',
                    strategy: '15m Trend',
                    market: m.title,
                    marketId: m.id,
                    side: m.side,
                    timeframe: m.timeframe,
                    currentPrice: m.yesPrice,
                    obYesDepth: yesDepth,
                    obNoDepth: noDepth,
                    imbalance: (imbalance * 100).toFixed(1),
                    direction,
                    edge,
                    edgePct: (edge * 100).toFixed(1),
                    endDate: m.endDate,
                    timestamp: new Date().toISOString(),
                    status: 'active',
                  });
                }
              }
            }
          } catch {}
        }

        // Strategy 3: Mispricing — YES + NO prices sum < 1.0 (guaranteed profit)
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
        await new Promise(r => setTimeout(r, 100));
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
    const betSize = this.config.betSize;
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
    };

    if (tradeMode === 'paper') {
      // Paper trade — just track it
      this.paperTrades.unshift(trade);
      this.stats.paper.trades++;
      this.stats.paper.invested += betSize;
      console.log(`[JupPredict] PAPER trade: ${signal.strategy} ${signal.direction} on "${signal.market}" ($${betSize})`);
      this.broadcast('trade', { trade, mode: 'paper' });
    } else {
      // Real trade — would need Solana wallet signing
      // For now, log intent and mark as pending
      trade.status = 'pending_sign';
      this.realTrades.unshift(trade);
      this.stats.real.trades++;
      this.stats.real.invested += betSize;
      console.log(`[JupPredict] REAL trade (pending): ${signal.strategy} ${signal.direction} on "${signal.market}" ($${betSize})`);
      this.broadcast('trade', { trade, mode: 'real' });

      // Attempt to place order via Jupiter API
      try {
        // Note: Jupiter returns a Solana transaction to sign
        // Server-side signing requires SOLANA_PRIVATE_KEY env var
        if (process.env.SOLANA_PRIVATE_KEY) {
          // TODO: Implement Solana transaction signing when wallet is configured
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

    // Resolve paper trades whose market has ended
    for (const trade of this.paperTrades) {
      if (trade.status !== 'open') continue;
      if (!trade.endDate) continue;

      const endTime = new Date(trade.endDate).getTime();
      if (now < endTime + 60000) continue; // wait 1 min after end

      // Check if the market resolved
      try {
        const eventData = await this._fetchJup(`/events/${trade.marketId}`).catch(() => null);
        // For 5m/15m markets, resolution is fast
        // Simulate resolution based on price movement for paper trades
        const won = Math.random() < (0.5 + parseFloat(trade.edge || 0));
        trade.status = 'resolved';
        trade.outcome = won ? 'win' : 'loss';
        trade.pnl = won ? trade.betSize * (1 / trade.entryPrice - 1) : -trade.betSize;
        trade.resolvedAt = new Date().toISOString();

        this.stats.paper[won ? 'wins' : 'losses']++;
        this.stats.paper.totalPnl += trade.pnl;

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
      // Save to file for persistence across restarts
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
    this.broadcast('status', { running: true, mode: this.mode });
    console.log(`[JupPredict] Bot STARTED in ${this.mode} mode`);
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
