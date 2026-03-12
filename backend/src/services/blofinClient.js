const fetch = require('node-fetch');
const crypto = require('crypto');

const DEMO_BASE = 'https://demo-trading-openapi.blofin.com';
const LIVE_BASE = 'https://openapi.blofin.com';

function getBaseUrl(demo) {
  return demo ? DEMO_BASE : LIVE_BASE;
}

/* ── Rate limiter (token bucket) ─────────────────────────────── */
const bucket = { tokens: 500, last: Date.now(), max: 500, refillMs: 60000 };
const tradeBucket = { tokens: 30, last: Date.now(), max: 30, refillMs: 10000 };

function consumeToken(b) {
  const now = Date.now();
  const elapsed = now - b.last;
  b.tokens = Math.min(b.max, b.tokens + (elapsed / b.refillMs) * b.max);
  b.last = now;
  if (b.tokens < 1) throw new Error('Rate limit exceeded — try again shortly');
  b.tokens--;
}

/* ── Auth helpers ─────────────────────────────────────────────── */

function sign(method, requestPath, body, timestamp, nonce, secretKey) {
  const bodyStr = body ? JSON.stringify(body) : '';
  const prehash = requestPath + method.toUpperCase() + timestamp + nonce + bodyStr;
  const hmac = crypto.createHmac('sha256', secretKey).update(prehash).digest('hex');
  return Buffer.from(hmac).toString('base64');
}

function authHeaders(method, requestPath, body, creds) {
  const timestamp = String(Math.floor(Date.now() / 1000));
  const nonce = crypto.randomUUID().replace(/-/g, '').slice(0, 32);
  const signature = sign(method, requestPath, body, timestamp, nonce, creds.secretKey);
  return {
    'ACCESS-KEY': creds.apiKey,
    'ACCESS-SIGN': signature,
    'ACCESS-TIMESTAMP': timestamp,
    'ACCESS-NONCE': nonce,
    'ACCESS-PASSPHRASE': creds.passphrase,
    'Content-Type': 'application/json',
  };
}

/* ── Generic REST helpers ────────────────────────────────────── */

async function publicGet(path, params, demo) {
  consumeToken(bucket);
  const baseUrl = getBaseUrl(demo);
  const qs = params ? '?' + new URLSearchParams(params).toString() : '';
  const url = baseUrl + path + qs;
  const res = await fetch(url, { headers: { 'Content-Type': 'application/json' } });
  if (!res.ok) throw new Error(`BloFin API ${path}: HTTP ${res.status}`);
  const json = await res.json();
  if (json.code !== '0') throw new Error(`BloFin ${path}: ${json.msg || json.code}`);
  return json.data;
}

async function privateGet(path, params, creds, demo) {
  consumeToken(bucket);
  const baseUrl = getBaseUrl(demo);
  const qs = params ? '?' + new URLSearchParams(params).toString() : '';
  const requestPath = path + qs;
  const headers = authHeaders('GET', requestPath, null, creds);
  const res = await fetch(baseUrl + requestPath, { headers });
  if (!res.ok) throw new Error(`BloFin API ${path}: HTTP ${res.status}`);
  const json = await res.json();
  if (json.code !== '0') throw new Error(`BloFin ${path}: ${json.msg || json.code}`);
  return json.data;
}

async function privatePost(path, body, creds, isTrading = false, demo) {
  consumeToken(isTrading ? tradeBucket : bucket);
  const baseUrl = getBaseUrl(demo);
  const headers = authHeaders('POST', path, body, creds);
  const res = await fetch(baseUrl + path, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`BloFin API ${path}: HTTP ${res.status}`);
  const json = await res.json();
  if (json.code !== '0') throw new Error(`BloFin ${path}: ${json.msg || json.code}`);
  return json.data;
}

/* ── Market Data (Public) ────────────────────────────────────── */

async function getMarkets(demo) {
  const data = await publicGet('/api/v1/market/instruments', { instType: 'SWAP' }, demo);
  return (data || []).map(inst => ({
    name: inst.instId,           // e.g. 'BTC-USDT'
    symbol: inst.instId.replace('-', ''),
    maxLeverage: parseInt(inst.maxLever) || 100,
    minSize: inst.minSize || '0.001',
    tickSize: inst.tickSize,
    contractValue: inst.contractValue,
    protocol: 'blofin',
  }));
}

async function getTicker(instId, demo) {
  const data = await publicGet('/api/v1/market/tickers', { instId }, demo);
  return data && data[0] ? {
    instId: data[0].instId,
    last: parseFloat(data[0].last),
    bid: parseFloat(data[0].bidPrice),
    ask: parseFloat(data[0].askPrice),
    high24h: parseFloat(data[0].high24h),
    low24h: parseFloat(data[0].low24h),
    volume24h: parseFloat(data[0].volCurrency24h),
    timestamp: data[0].ts,
  } : null;
}

async function getCandles(instId, bar, limit, demo) {
  return publicGet('/api/v1/market/candles', { instId, bar, limit: limit || '100' }, demo);
}

async function getFundingRate(instId, demo) {
  const data = await publicGet('/api/v1/market/funding-rate', { instId }, demo);
  return data && data[0] ? {
    instId: data[0].instId,
    fundingRate: parseFloat(data[0].fundingRate),
    nextFundingTime: data[0].nextFundingTime,
  } : null;
}

async function getMarkPrice(instId, demo) {
  const data = await publicGet('/api/v1/market/mark-price', { instId, instType: 'SWAP' }, demo);
  return data && data[0] ? parseFloat(data[0].markPrice) : null;
}

/* ── Account (Private) ───────────────────────────────────────── */

async function getBalance(creds, demo) {
  const data = await privateGet('/api/v1/account/balance', null, creds, demo);
  // BloFin returns array of account details
  if (!data || data.length === 0) return { usdt: 0, locked: false };
  const acct = data[0];
  const usdtDetail = (acct.details || []).find(d => d.currency === 'USDT');
  return {
    totalEquity: parseFloat(acct.totalEquity) || 0,
    availableBalance: parseFloat(usdtDetail?.availableBalance || acct.totalEquity) || 0,
    usdt: parseFloat(usdtDetail?.balance || acct.totalEquity) || 0,
    frozenBalance: parseFloat(usdtDetail?.frozenBalance || 0),
    locked: false,
  };
}

async function getPositions(creds, demo) {
  const data = await privateGet('/api/v1/account/positions', null, creds, demo);
  return (data || []).map(p => ({
    instId: p.instId,
    market: p.instId,
    direction: p.positionSide === 'long' ? 'long' : 'short',
    size: parseFloat(p.positions) || 0,
    sizeUsd: parseFloat(p.notionalUsd) || 0,
    collateral: parseFloat(p.margin) || 0,
    leverage: parseFloat(p.leverage) || 1,
    entryPrice: parseFloat(p.averagePrice) || 0,
    markPrice: parseFloat(p.markPrice) || 0,
    pnl: parseFloat(p.unrealizedPnl) || 0,
    liquidationPrice: parseFloat(p.liquidationPrice) || 0,
    marginMode: p.marginMode || 'cross',
    protocol: 'blofin',
  }));
}

/* ── Trading (Private) ───────────────────────────────────────── */

async function setLeverage(creds, instId, lever, marginMode, demo) {
  return privatePost('/api/v1/account/set-leverage', {
    instId,
    lever: String(lever),
    marginMode: marginMode || 'cross',
  }, creds, false, demo);
}

async function setMarginMode(creds, instId, marginMode, demo) {
  return privatePost('/api/v1/account/set-margin-mode', {
    instId,
    marginMode, // 'cross' or 'isolated'
  }, creds, false, demo);
}

async function openPosition({ creds, instId, direction, size, leverage, orderType, price, tpPrice, slPrice, marginMode, demo }) {
  const mode = marginMode || 'cross';

  // Set leverage first
  try {
    await setLeverage(creds, instId, leverage, mode, demo);
  } catch (e) {
    // Leverage may already be set — non-fatal
    console.warn(`[BloFin] setLeverage warning: ${e.message}`);
  }

  // Place the order
  const side = direction === 'long' ? 'buy' : 'sell';
  const body = {
    instId,
    tradeMode: mode,
    side,
    orderType: orderType || 'market',
    size: String(size),
    positionSide: direction, // 'long' or 'short' for hedge mode
  };
  if (orderType === 'limit' && price) {
    body.price = String(price);
  }

  const orderData = await privatePost('/api/v1/trade/order', body, creds, true, demo);
  const orderId = orderData && orderData[0] ? orderData[0].orderId : (orderData?.orderId || null);

  // Set TP/SL if provided
  if ((tpPrice || slPrice) && orderId) {
    try {
      const tpslBody = { instId, positionSide: direction };
      if (tpPrice) {
        tpslBody.tpTriggerPrice = String(tpPrice);
        tpslBody.tpOrderPrice = '-1'; // market price
      }
      if (slPrice) {
        tpslBody.slTriggerPrice = String(slPrice);
        tpslBody.slOrderPrice = '-1'; // market price
      }
      await privatePost('/api/v1/trade/order-tpsl', tpslBody, creds, true, demo);
    } catch (e) {
      console.warn(`[BloFin] TP/SL setting warning: ${e.message}`);
    }
  }

  console.log(`[BloFin] Opened ${direction} ${instId} | Size: ${size} | Lev: ${leverage}x | Order: ${orderId}`);
  return { orderId, protocol: 'blofin' };
}

async function closePosition({ creds, instId, direction, demo }) {
  const side = direction === 'long' ? 'sell' : 'buy';
  const body = {
    instId,
    tradeMode: 'cross',
    side,
    orderType: 'market',
    size: '0',            // 0 = close all
    positionSide: direction,
    reduceOnly: true,
  };

  const data = await privatePost('/api/v1/trade/order', body, creds, true, demo);
  const orderId = data && data[0] ? data[0].orderId : (data?.orderId || null);
  console.log(`[BloFin] Closed ${direction} ${instId} | Order: ${orderId}`);
  return { orderId };
}

async function cancelOrder(creds, instId, orderId, demo) {
  return privatePost('/api/v1/trade/cancel-order', { instId, orderId }, creds, true, demo);
}

async function getActiveOrders(creds, instId, demo) {
  const params = instId ? { instId } : {};
  return privateGet('/api/v1/trade/active-orders', params, creds, demo);
}

async function getOrderHistory(creds, instId, demo) {
  const params = instId ? { instId } : {};
  return privateGet('/api/v1/trade/order-history', params, creds, demo);
}

module.exports = {
  getBaseUrl,
  DEMO_BASE,
  LIVE_BASE,
  getMarkets,
  getTicker,
  getCandles,
  getFundingRate,
  getMarkPrice,
  getBalance,
  getPositions,
  setLeverage,
  setMarginMode,
  openPosition,
  closePosition,
  cancelOrder,
  getActiveOrders,
  getOrderHistory,
};
