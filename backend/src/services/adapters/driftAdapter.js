const PerpAdapter = require('./perpAdapter');
const { connection } = require('../solanaRpc');
const fetch = require('node-fetch');

// Drift SDK is ESM-only — use dynamic import() from CommonJS
let DriftClient, Wallet, initialize, BN, PositionDirection, OrderType;
let getMarketsAndOraclesForSubscription;
let driftLoaded = false;

async function loadDriftSDK() {
  if (driftLoaded) return;
  try {
    const sdk = await import('@drift-labs/sdk');
    DriftClient = sdk.DriftClient;
    Wallet = sdk.Wallet;
    initialize = sdk.initialize;
    BN = sdk.BN || (await import('bn.js')).default;
    PositionDirection = sdk.PositionDirection;
    OrderType = sdk.OrderType;
    getMarketsAndOraclesForSubscription = sdk.getMarketsAndOraclesForSubscription;
    driftLoaded = true;
    console.log('[Drift] SDK loaded via dynamic import');
  } catch (err) {
    console.error('[Drift] Failed to load SDK:', err.message);
    throw new Error('Drift SDK not available: ' + err.message);
  }
}

// Drift perp markets — wider selection than Jupiter
const DRIFT_MARKETS = {
  'SOL-PERP':   { marketIndex: 0,  symbol: 'SOLUSDT',  maxLev: 20 },
  'BTC-PERP':   { marketIndex: 1,  symbol: 'BTCUSDT',  maxLev: 20 },
  'ETH-PERP':   { marketIndex: 2,  symbol: 'ETHUSDT',  maxLev: 20 },
  'APT-PERP':   { marketIndex: 3,  symbol: 'APTUSDT',  maxLev: 10 },
  'MATIC-PERP': { marketIndex: 4,  symbol: 'MATICUSDT', maxLev: 10 },
  'ARB-PERP':   { marketIndex: 5,  symbol: 'ARBUSDT',  maxLev: 10 },
  'DOGE-PERP':  { marketIndex: 6,  symbol: 'DOGEUSDT', maxLev: 10 },
  'BNB-PERP':   { marketIndex: 7,  symbol: 'BNBUSDT',  maxLev: 10 },
  'SUI-PERP':   { marketIndex: 8,  symbol: 'SUIUSDT',  maxLev: 10 },
  'WIF-PERP':   { marketIndex: 14, symbol: 'WIFUSDT',  maxLev: 5 },
  'JTO-PERP':   { marketIndex: 15, symbol: 'JTOUSDT',  maxLev: 5 },
  'JUP-PERP':   { marketIndex: 24, symbol: 'JUPUSDT',  maxLev: 5 },
};

// Cache DriftClient instances per user
const clientCache = new Map();

class DriftAdapter extends PerpAdapter {
  constructor() {
    super('drift');
  }

  async _getClient(keypair) {
    await loadDriftSDK();
    const pubkey = keypair.publicKey.toBase58();
    if (clientCache.has(pubkey)) return clientCache.get(pubkey);

    const wallet = new Wallet(keypair);
    const sdkConfig = initialize({ env: 'mainnet-beta' });

    const client = new DriftClient({
      connection,
      wallet,
      env: 'mainnet-beta',
      ...getMarketsAndOraclesForSubscription('mainnet-beta'),
    });

    await client.subscribe();
    clientCache.set(pubkey, client);
    console.log(`[Drift] Client initialized for ${pubkey.slice(0, 8)}...`);
    return client;
  }

  async getMarkets() {
    return Object.entries(DRIFT_MARKETS).map(([name, m]) => ({
      name,
      symbol: m.symbol,
      maxLeverage: m.maxLev,
      protocol: 'drift',
    }));
  }

  async openPosition({ keypair, market, direction, collateralUsd, leverage }) {
    await loadDriftSDK();
    const client = await this._getClient(keypair);
    const marketInfo = DRIFT_MARKETS[market];
    if (!marketInfo) throw new Error(`Drift: unknown market ${market}`);

    const collateralBN = new BN(Math.round(collateralUsd * 1e6));
    const dir = direction === 'long' ? PositionDirection.LONG : PositionDirection.SHORT;

    // Deposit USDC collateral
    await client.deposit(collateralBN, 0); // spot market 0 = USDC

    // Place perp market order
    const baseAmount = new BN(Math.round(collateralUsd * leverage * 1e6));
    const orderParams = {
      orderType: OrderType.MARKET,
      marketIndex: marketInfo.marketIndex,
      direction: dir,
      baseAssetAmount: baseAmount,
    };

    const txSig = await client.placePerpOrder(orderParams);
    console.log(`[Drift] Opened ${direction} ${market} | Collateral: $${collateralUsd} | Lev: ${leverage}x | Tx: ${txSig}`);
    return { txSignature: txSig, protocol: 'drift' };
  }

  async closePosition({ keypair, market }) {
    await loadDriftSDK();
    const client = await this._getClient(keypair);
    const marketInfo = DRIFT_MARKETS[market];
    if (!marketInfo) throw new Error(`Drift: unknown market ${market}`);

    const txSig = await client.closePosition(marketInfo.marketIndex);
    console.log(`[Drift] Closed position on ${market} | Tx: ${txSig}`);
    return { txSignature: txSig };
  }

  async getPositions(publicKeyStr) {
    try {
      const res = await fetch(
        `https://mainnet-beta.api.drift.trade/positions?authority=${publicKeyStr}`
      );
      if (!res.ok) return [];
      const data = await res.json();
      return (Array.isArray(data) ? data : []).map(p => ({
        market: Object.entries(DRIFT_MARKETS).find(([_, m]) => m.marketIndex === p.marketIndex)?.[0] || `market-${p.marketIndex}`,
        direction: p.baseAssetAmount > 0 ? 'long' : 'short',
        size: Math.abs(p.quoteAssetAmount || 0) / 1e6,
        collateral: (p.collateral || 0) / 1e6,
        leverage: p.leverage || 1,
        entryPrice: p.entryPrice ? p.entryPrice / 1e6 : 0,
        markPrice: p.oraclePrice ? p.oraclePrice / 1e6 : 0,
        pnl: (p.unrealizedPnl || 0) / 1e6,
        liquidationPrice: p.liquidationPrice ? p.liquidationPrice / 1e6 : null,
        protocol: 'drift',
      }));
    } catch {
      return [];
    }
  }

  async getBalance(publicKey) {
    const { getSolBalance, getTokenBalance, USDC_MINT } = require('../solanaRpc');
    const sol = await getSolBalance(publicKey);
    const usdc = await getTokenBalance(publicKey, USDC_MINT);
    return { sol, usdc, protocol: 'drift' };
  }

  async getFundingRate(market) {
    const marketInfo = DRIFT_MARKETS[market];
    if (!marketInfo) return null;
    try {
      const res = await fetch(
        `https://mainnet-beta.api.drift.trade/fundingRates?marketIndex=${marketInfo.marketIndex}`
      );
      if (!res.ok) return null;
      const data = await res.json();
      return Array.isArray(data) && data[0] ? data[0].fundingRate : null;
    } catch {
      return null;
    }
  }

  async disconnectClient(publicKey) {
    const client = clientCache.get(publicKey);
    if (client) {
      try { await client.unsubscribe(); } catch {}
      clientCache.delete(publicKey);
    }
  }
}

module.exports = new DriftAdapter();
