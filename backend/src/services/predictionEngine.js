const fetch = require('node-fetch');
const { EventEmitter } = require('events');

const GAMMA_URL = 'https://gamma-api.polymarket.com';
const CLOB_URL = 'https://clob.polymarket.com';

class PredictionEngine extends EventEmitter {
  constructor() {
    super();
    this.markets = [];          // active crypto prediction markets
    this.signals = [];          // detected arbitrage signals (last 50)
    this.performance = [];      // trade history with outcomes
    this.sseClients = [];       // SSE response objects
    this.running = false;       // bot running state
    this.config = {
      betSize: 10,              // USDC per trade
      edgeThreshold: 0.10,     // minimum 10% edge to trade
      sniperEnabled: true,
      arbEnabled: true,
    };
    this.pollTimer = null;
    this.priceCache = {};       // { 'BTC': 83000, 'ETH': 3200, ... }
  }

  start() {
    this.pollTimer = setInterval(() => this.pollMarkets(), 60000);
    this.pollMarkets(); // immediate first poll
    console.log('Prediction engine started.');
  }

  stop() {
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.pollTimer = null;
  }

  async pollMarkets() {
    try {
      // Fetch active crypto prediction markets from Gamma API
      const r = await fetch(`${GAMMA_URL}/events?closed=false&limit=100&order=volume&ascending=false`);
      if (!r.ok) return;
      const events = await r.json();

      // Filter for crypto-related markets
      const cryptoKeywords = ['bitcoin', 'btc', 'ethereum', 'eth', 'solana', 'sol', 'crypto', 'token', 'defi', 'price', 'above', 'below'];
      const cryptoEvents = (Array.isArray(events) ? events : []).filter(e => {
        const text = ((e.title || '') + ' ' + (e.description || '')).toLowerCase();
        return cryptoKeywords.some(k => text.includes(k));
      });

      // Extract markets from events
      this.markets = [];
      for (const event of cryptoEvents.slice(0, 30)) {
        const markets = event.markets || [];
        for (const m of markets) {
          this.markets.push({
            id: m.id,
            conditionId: m.conditionId,
            question: m.question || event.title,
            description: m.description || event.description || '',
            yesTokenId: m.clobTokenIds?.[0] || m.tokens?.[0]?.token_id,
            noTokenId: m.clobTokenIds?.[1] || m.tokens?.[1]?.token_id,
            outcomePrices: m.outcomePrices ? JSON.parse(m.outcomePrices) : null,
            volume: parseFloat(m.volume || 0),
            liquidity: parseFloat(m.liquidity || 0),
            endDate: m.endDate || event.endDate,
            active: m.active,
            closed: m.closed,
          });
        }
      }

      // Run arbitrage detection on all markets
      await this.detectArbitrage();

      // Broadcast updated markets to SSE clients
      this.broadcast('markets', { count: this.markets.length });

    } catch (err) {
      console.error('Prediction poll error:', err.message);
    }
  }

  async detectArbitrage() {
    const newSignals = [];

    for (const market of this.markets) {
      if (!market.yesTokenId || !market.noTokenId) continue;

      try {
        // Fetch orderbook for YES and NO tokens
        const [yesR, noR] = await Promise.all([
          fetch(`${CLOB_URL}/price?token_id=${market.yesTokenId}&side=buy`).then(r => r.json()).catch(() => null),
          fetch(`${CLOB_URL}/price?token_id=${market.noTokenId}&side=buy`).then(r => r.json()).catch(() => null),
        ]);

        const yesPrice = yesR?.price ? parseFloat(yesR.price) : null;
        const noPrice = noR?.price ? parseFloat(noR.price) : null;

        if (yesPrice && noPrice) {
          // Strategy 2: Yes+No Arbitrage
          const totalCost = yesPrice + noPrice;
          const fees = 0.02; // 2% Polymarket fee
          if (totalCost < (1 - fees)) {
            const guaranteedProfit = ((1 - totalCost) / totalCost * 100).toFixed(2);
            newSignals.push({
              id: Date.now() + '-arb-' + market.id,
              type: 'arbitrage',
              market: market.question,
              marketId: market.id,
              yesPrice,
              noPrice,
              totalCost,
              edge: (1 - totalCost - fees),
              guaranteedProfit: parseFloat(guaranteedProfit),
              timestamp: new Date().toISOString(),
              status: 'active',
            });
          }
        }

        // Strategy 1: BTC Price Sniper
        // Check if this is a "BTC above/below $X" type market
        const q = (market.question || '').toLowerCase();
        const priceMatch = q.match(/(?:bitcoin|btc).*?(?:above|below|over|under).*?\$?([\d,]+)/i);
        if (priceMatch && this.priceCache.BTC) {
          const threshold = parseFloat(priceMatch[1].replace(/,/g, ''));
          const isAboveMarket = q.includes('above') || q.includes('over');
          const realPrice = this.priceCache.BTC;

          // Calculate what the "fair" probability should be based on real price
          // If BTC is well above threshold, YES should be near 1.0
          const distancePct = (realPrice - threshold) / threshold;
          let fairYesProb;
          if (isAboveMarket) {
            fairYesProb = distancePct > 0.02 ? 0.95 : distancePct > 0 ? 0.65 : distancePct > -0.02 ? 0.35 : 0.05;
          } else {
            fairYesProb = distancePct < -0.02 ? 0.95 : distancePct < 0 ? 0.65 : distancePct < 0.02 ? 0.35 : 0.05;
          }

          if (yesPrice && Math.abs(fairYesProb - yesPrice) > this.config.edgeThreshold) {
            const direction = fairYesProb > yesPrice ? 'BUY YES' : 'BUY NO';
            const edge = Math.abs(fairYesProb - yesPrice);
            newSignals.push({
              id: Date.now() + '-sniper-' + market.id,
              type: 'sniper',
              market: market.question,
              marketId: market.id,
              realPrice,
              threshold,
              yesPrice,
              fairYesProb,
              direction,
              edge,
              edgePct: (edge * 100).toFixed(1),
              timestamp: new Date().toISOString(),
              status: 'active',
            });
          }
        }

        // Small delay to avoid rate limiting
        await new Promise(r => setTimeout(r, 100));

      } catch (err) {
        // Skip individual market errors
      }
    }

    if (newSignals.length > 0) {
      this.signals = [...newSignals, ...this.signals].slice(0, 50);
      this.broadcast('signals', newSignals);
    }
  }

  updatePrice(symbol, price) {
    this.priceCache[symbol] = price;
  }

  getMarkets() { return this.markets; }
  getSignals() { return this.signals; }
  getPerformance() { return this.performance; }
  getConfig() { return this.config; }

  setConfig(newConfig) {
    Object.assign(this.config, newConfig);
  }

  isRunning() { return this.running; }

  startBot() { this.running = true; this.broadcast('status', { running: true }); }
  stopBot() { this.running = false; this.broadcast('status', { running: false }); }

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
