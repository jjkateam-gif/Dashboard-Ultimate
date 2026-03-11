const WebSocket = require('ws');
const crypto = require('crypto');
const EventEmitter = require('events');

const WS_PUBLIC  = process.env.BLOFIN_DEMO === 'true'
  ? 'wss://demo-trading-openapi.blofin.com/ws/public'
  : 'wss://openapi.blofin.com/ws/public';

const WS_PRIVATE = process.env.BLOFIN_DEMO === 'true'
  ? 'wss://demo-trading-openapi.blofin.com/ws/private'
  : 'wss://openapi.blofin.com/ws/private';

class BloFinWs extends EventEmitter {
  constructor() {
    super();
    this.publicWs = null;
    this.privateConnections = new Map(); // userId -> { ws, creds, sseClients: Set }
    this.reconnectDelays = new Map();
  }

  /* ── Public WebSocket (singleton) ─────────────────────────── */

  connectPublic(channels) {
    if (this.publicWs && this.publicWs.readyState === WebSocket.OPEN) return;

    const ws = new WebSocket(WS_PUBLIC);
    this.publicWs = ws;

    ws.on('open', () => {
      console.log('[BloFinWs] Public WS connected');
      this.reconnectDelays.delete('public');

      // Subscribe to requested channels
      const args = (channels || []).map(ch => {
        if (typeof ch === 'string') return { channel: ch };
        return ch;
      });
      if (args.length > 0) {
        ws.send(JSON.stringify({ op: 'subscribe', args }));
      }

      // Heartbeat every 25s
      this._startHeartbeat(ws, 'public');
    });

    ws.on('message', (raw) => {
      const msg = raw.toString();
      if (msg === 'pong') return;
      try {
        const data = JSON.parse(msg);
        if (data.arg && data.data) {
          this.emit('public:' + data.arg.channel, data);
        }
      } catch {}
    });

    ws.on('close', () => {
      console.log('[BloFinWs] Public WS disconnected');
      this._reconnect('public', () => this.connectPublic(channels));
    });

    ws.on('error', (err) => {
      console.error('[BloFinWs] Public WS error:', err.message);
    });
  }

  /* ── Private WebSocket (per-user) ─────────────────────────── */

  connectPrivate(userId, creds) {
    // Close existing connection for this user
    this.disconnectPrivate(userId);

    const ws = new WebSocket(WS_PRIVATE);
    const entry = { ws, creds, sseClients: new Set() };
    this.privateConnections.set(userId, entry);

    ws.on('open', () => {
      console.log(`[BloFinWs] Private WS connected for user ${userId}`);
      this.reconnectDelays.delete('private:' + userId);

      // Authenticate
      const timestamp = String(Math.floor(Date.now() / 1000));
      const nonce = crypto.randomUUID().replace(/-/g, '').slice(0, 32);
      const prehash = '/ws/private' + 'GET' + timestamp + nonce;
      const hmac = crypto.createHmac('sha256', creds.secretKey).update(prehash).digest('hex');
      const sign = Buffer.from(hmac).toString('base64');

      ws.send(JSON.stringify({
        op: 'login',
        args: [{ apiKey: creds.apiKey, timestamp, nonce, sign }],
      }));
    });

    ws.on('message', (raw) => {
      const msg = raw.toString();
      if (msg === 'pong') return;
      try {
        const data = JSON.parse(msg);

        // Login success → subscribe to private channels
        if (data.event === 'login' && data.code === '0') {
          ws.send(JSON.stringify({
            op: 'subscribe',
            args: [
              { channel: 'positions' },
              { channel: 'orders' },
              { channel: 'account' },
            ],
          }));
          this._startHeartbeat(ws, 'private:' + userId);
          return;
        }

        // Forward data events
        if (data.arg && data.data) {
          const channel = data.arg.channel;
          this.emit(`private:${userId}:${channel}`, data);

          // Forward to SSE clients
          for (const sseRes of entry.sseClients) {
            try {
              sseRes.write(`event: ${channel}\ndata: ${JSON.stringify(data.data)}\n\n`);
            } catch {}
          }
        }
      } catch {}
    });

    ws.on('close', () => {
      console.log(`[BloFinWs] Private WS disconnected for user ${userId}`);
      this._reconnect('private:' + userId, () => this.connectPrivate(userId, creds));
    });

    ws.on('error', (err) => {
      console.error(`[BloFinWs] Private WS error for user ${userId}:`, err.message);
    });
  }

  disconnectPrivate(userId) {
    const entry = this.privateConnections.get(userId);
    if (entry) {
      try { entry.ws.close(); } catch {}
      entry.sseClients.clear();
      this.privateConnections.delete(userId);
    }
  }

  /* ── SSE client management ────────────────────────────────── */

  addSseClient(userId, res) {
    const entry = this.privateConnections.get(userId);
    if (entry) {
      entry.sseClients.add(res);
      res.on('close', () => entry.sseClients.delete(res));
    }
  }

  /* ── Heartbeat ────────────────────────────────────────────── */

  _startHeartbeat(ws, key) {
    const interval = setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send('ping');
      } else {
        clearInterval(interval);
      }
    }, 25000);
    ws['_hb_' + key] = interval;
  }

  /* ── Reconnection with exponential backoff ────────────────── */

  _reconnect(key, connectFn) {
    const current = this.reconnectDelays.get(key) || 1000;
    const next = Math.min(current * 2, 30000);
    this.reconnectDelays.set(key, next);
    console.log(`[BloFinWs] Reconnecting ${key} in ${current}ms`);
    setTimeout(connectFn, current);
  }

  /* ── Cleanup ──────────────────────────────────────────────── */

  closeAll() {
    if (this.publicWs) {
      try { this.publicWs.close(); } catch {}
      this.publicWs = null;
    }
    for (const [userId] of this.privateConnections) {
      this.disconnectPrivate(userId);
    }
  }
}

module.exports = new BloFinWs();
