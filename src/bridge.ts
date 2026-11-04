import { chmod, mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { createServer } from 'node:http';
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { WebSocketServer, WebSocket } from 'ws';
import { setTimeout as delay } from 'node:timers/promises';

const DEFAULT_PORT = 37123;
const MAX_SOCKETS = 32;
const MAX_PAYLOAD = 128 * 1024;
const tokenPattern = /^[a-f0-9]{64}$/;
const sessionPattern = /^[A-Za-z0-9-]{1,100}$/;
const LOST = 'Browser disconnected; an in-flight click may have occurred. Read before retrying.';
const NOT_CONNECTED = 'Browser disconnected. Saved pairing reconnects automatically; check /browser and the Chrome popup. Pair only for first setup; do not reset to reconnect.';

const send = (ws, message) => {
  if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(message));
};
const sameSecret = (supplied, expected) => {
  const a = Buffer.from(typeof supplied === 'string' ? supplied : '');
  const b = Buffer.from(expected ?? '');
  return b.length > 0 && a.length === b.length && timingSafeEqual(a, b);
};

// Every Pi session has a bridge. In persistent mode the first one to bind the saved
// port is the hub: it owns the Chrome socket and relays commands for the others,
// which join it over the same WebSocket port. If the hub exits, a remaining session
// takes the port over quietly. The secret never enters model context.
export class Bridge {
  pending = new Map();
  sockets = new Set(); // hub: every accepted socket
  sessions = new Map(); // hub: joined Pi socket -> { id, label }
  routes = new Map(); // hub: relayed command id -> Pi socket that sent it
  peer = null; // hub: the paired Chrome socket
  hub = null; // joined session: its socket to the hub
  mode = undefined; // 'hub' | 'client' | undefined
  browserConnected = false; // joined session: the hub reports Chrome is paired
  running = false;
  epoch = 0;
  retryDelay = 100;

  constructor(options = {}) {
    this.persistent = options.persistent === true;
    this.statePath = options.statePath ?? process.env.PI_BROWSER_STATE_PATH ?? join(homedir(), '.pi', 'pi-browser', 'credentials.json');
    const configuredPort = options.port ?? (process.env.PI_BROWSER_PORT === undefined
      ? (this.persistent ? DEFAULT_PORT : 0) : Number(process.env.PI_BROWSER_PORT));
    if (!Number.isInteger(configuredPort) || configuredPort < 0 || configuredPort > 65535) {
      throw new Error('PI_BROWSER_PORT must be an integer between 0 and 65535');
    }
    this.port = configuredPort;
    this.useStoredPort = options.port === undefined && process.env.PI_BROWSER_PORT === undefined;
    this.session = randomUUID();
    this.label = String(options.label ?? `${basename(process.cwd())} · pid ${process.pid}`).slice(0, 100);
  }

  transition(work) {
    const next = (this.lifecycle ?? Promise.resolve()).catch(() => {}).then(work);
    this.lifecycle = next;
    return next;
  }

  start() { return this.transition(() => this.open()); }
  stop(options = {}) { return this.transition(() => this.close(options)); }

  browserReady() {
    if (this.mode === 'hub') return this.peer?.readyState === WebSocket.OPEN;
    return this.mode === 'client' && this.hub?.readyState === WebSocket.OPEN && this.browserConnected;
  }

  async loadProfile() {
    let stored;
    try {
      stored = JSON.parse(await readFile(this.statePath, 'utf8'));
    } catch (error) {
      if (error.code !== 'ENOENT') throw new Error(`Cannot read browser credentials: ${error.message}`);
    }
    const configuredToken = process.env.PI_BROWSER_TOKEN;
    const token = configuredToken ?? stored?.token ?? randomBytes(32).toString('hex');
    if (!tokenPattern.test(token)) throw new Error('PI_BROWSER_TOKEN or stored browser token is invalid');
    const port = this.useStoredPort && Number.isInteger(stored?.port) ? stored.port : this.port;
    if (port < 0 || port > 65535) throw new Error('Stored browser port is invalid');
    return { token, port };
  }

  async saveProfile(token, port) {
    if (!this.persistent) return;
    await mkdir(dirname(this.statePath), { recursive: true, mode: 0o700 });
    await writeFile(this.statePath, `${JSON.stringify({ token, port })}\n`, { mode: 0o600 });
    await chmod(this.statePath, 0o600);
  }

  async open() {
    if (this.mode) return this.pairing;
    clearTimeout(this.retryTimer);
    this.retryTimer = undefined;
    const profile = this.persistent ? await this.loadProfile() : {
      token: randomBytes(32).toString('hex'), port: this.port,
    };
    this.waitingPort = profile.port;
    try {
      await this.listen(profile);
    } catch (error) {
      if (!this.persistent || error.code !== 'EADDRINUSE') throw error;
      // Another Pi session owns the saved port. Join it rather than fight over it.
      this.running = true;
      try { await this.join(profile.port); } catch { this.scheduleRetry(); }
      return this.pairing;
    }
    this.running = true;
    return this.pairing;
  }

  async listen(profile) {
    const server = createServer((_req, res) => res.writeHead(404).end());
    const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_PAYLOAD });
    server.on('upgrade', (req, socket, head) => {
      const host = req.headers.host === `127.0.0.1:${server.address()?.port}`;
      const chrome = req.url === '/browser' && /^chrome-extension:\/\/[a-p]{32}$/.test(req.headers.origin ?? '');
      // Browsers always send Origin, so web pages cannot reach the Pi session path.
      const pi = this.persistent && req.url === '/pi' && req.headers.origin === undefined;
      if (!host || !(chrome || pi) || this.sockets.size >= MAX_SOCKETS) return socket.destroy();
      wss.handleUpgrade(req, socket, head, (ws) => (chrome ? this.acceptChrome(ws) : this.acceptSession(ws)));
    });
    try {
      await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(profile.port, '127.0.0.1', resolve);
      });
      await this.saveProfile(profile.token, server.address().port);
    } catch (error) {
      wss.close();
      server.close();
      server.closeAllConnections();
      throw error;
    }
    this.server = server;
    this.wss = wss;
    this.token = profile.token;
    this.mode = 'hub';
    this.retryDelay = 100;
    this.pairing = { port: server.address().port, token: this.token };
  }

  // Shared socket housekeeping: auth deadline, idle timeout, JSON framing and ping.
  track(ws, { authenticate, handle, closed }) {
    this.sockets.add(ws);
    let authenticated = false;
    let lastSeen = Date.now();
    const authDeadline = setTimeout(() => ws.close(1008, 'Pairing required'), 5000);
    const idle = setInterval(() => {
      if (Date.now() - lastSeen > 45_000) ws.terminate();
    }, 20_000);
    ws.on('error', () => {});
    ws.on('message', (raw) => {
      let message;
      try { message = JSON.parse(raw.toString()); } catch { return ws.close(1008, 'Invalid JSON'); }
      if (!authenticated) {
        if (!authenticate(message)) return ws.close(1008, 'Pairing refused');
        authenticated = true;
        clearTimeout(authDeadline);
        return;
      }
      lastSeen = Date.now();
      if (message?.type === 'ping') return send(ws, { type: 'pong' });
      if (!handle(message)) ws.close(1008, 'Invalid message');
    });
    ws.on('close', () => {
      clearTimeout(authDeadline);
      clearInterval(idle);
      this.sockets.delete(ws);
      if (authenticated) closed();
    });
  }

  sessionList() {
    return [{ id: this.session, label: this.label }, ...this.sessions.values()];
  }

  // Chrome learns which sessions exist so it can keep each session's tabs apart.
  tellChrome() { send(this.peer, { type: 'sessions', sessions: this.sessionList() }); }
  tellSessions() {
    for (const ws of this.sessions.keys()) send(ws, { type: 'browser', connected: this.peer !== null });
  }

  acceptChrome(ws) {
    this.track(ws, {
      authenticate: (message) => {
        if (message?.type !== 'pair' || !sameSecret(message.token, this.token) || this.peer) return false;
        this.peer = ws;
        send(ws, { type: 'paired', sessions: this.sessionList() });
        this.tellSessions();
        return true;
      },
      handle: (message) => {
        if (message?.type !== 'result' || typeof message.id !== 'string') return false;
        const route = this.routes.get(message.id);
        if (route) {
          this.routes.delete(message.id);
          send(route, { type: 'result', id: message.id, result: message.result, error: message.error });
        } else this.settle(message);
        return true;
      },
      closed: () => {
        if (this.peer !== ws) return;
        this.peer = null;
        this.rejectPending(LOST);
        for (const [id, route] of this.routes) send(route, { type: 'result', id, error: LOST });
        this.routes.clear();
        this.tellSessions();
      },
    });
  }

  acceptSession(ws) {
    this.track(ws, {
      authenticate: (message) => {
        const id = message?.session;
        if (message?.type !== 'join' || !sameSecret(message.token, this.token) ||
            typeof id !== 'string' || !sessionPattern.test(id) ||
            this.sessionList().some((session) => session.id === id)) return false;
        const label = typeof message.label === 'string' && message.label.trim() ? message.label.slice(0, 100) : 'Pi session';
        this.sessions.set(ws, { id, label });
        send(ws, { type: 'joined', browser: this.peer !== null });
        this.tellChrome();
        return true;
      },
      handle: (message) => {
        if (message?.type === 'command') {
          const { id } = message;
          if (typeof id !== 'string' || id.length > 100 || this.routes.has(id) || this.pending.has(id)) return false;
          if (this.peer?.readyState !== WebSocket.OPEN) {
            send(ws, { type: 'result', id, error: NOT_CONNECTED });
            return true;
          }
          this.routes.set(id, ws);
          // The hub stamps the session, so one session cannot speak for another.
          send(this.peer, { type: 'command', id, op: message.op, args: message.args,
            expiresAt: message.expiresAt, session: this.sessions.get(ws).id });
          return true;
        }
        if (message?.type === 'cancel' && typeof message.id === 'string') {
          if (this.routes.get(message.id) === ws) {
            this.routes.delete(message.id);
            send(this.peer, { type: 'cancel', id: message.id });
          }
          return true;
        }
        if (message?.type === 'revoke') {
          send(this.peer, { type: 'revoke' });
          this.peer?.close(1000, 'revoked');
          return true;
        }
        if (message?.type === 'reset') {
          // Rotate for everyone, then take part again like any other session.
          void this.reset().then(() => this.start()).catch(() => this.scheduleRetry());
          return true;
        }
        return false;
      },
      closed: () => {
        this.sessions.delete(ws);
        for (const [id, route] of this.routes) {
          if (route !== ws) continue;
          this.routes.delete(id);
          send(this.peer, { type: 'cancel', id });
        }
        this.tellChrome();
      },
    });
  }

  async join(port) {
    const { token } = await this.loadProfile(); // Re-read: the hub may have just saved it.
    const ws = new WebSocket(`ws://127.0.0.1:${port}/pi`, { maxPayload: MAX_PAYLOAD });
    let joined = false;
    let ping;
    ws.on('error', () => {});
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => { ws.terminate(); reject(new Error('Join timed out')); }, 3000);
      ws.on('open', () => send(ws, { type: 'join', token, session: this.session, label: this.label }));
      ws.on('message', (raw) => {
        let message;
        try { message = JSON.parse(raw.toString()); } catch { return; }
        if (!joined) {
          clearTimeout(timer);
          if (message?.type !== 'joined') { ws.terminate(); return reject(new Error('Join refused')); }
          joined = true;
          this.browserConnected = message.browser === true;
          this.hub = ws;
          this.mode = 'client';
          this.token = token;
          this.pairing = { port, token };
          this.retryDelay = 100;
          ping = setInterval(() => send(ws, { type: 'ping' }), 15_000);
          ping.unref?.();
          return resolve();
        }
        if (message?.type === 'result' && typeof message.id === 'string') this.settle(message);
        else if (message?.type === 'browser') this.browserConnected = message.connected === true;
      });
      ws.on('close', () => {
        clearTimeout(timer);
        clearInterval(ping);
        if (!joined) return reject(new Error('Join refused'));
        if (this.hub !== ws) return;
        this.hub = null;
        this.mode = undefined;
        this.pairing = undefined;
        this.browserConnected = false;
        this.rejectPending(LOST);
        this.scheduleRetry(0); // The hub left: take the port over, or join whoever did.
      });
    });
  }

  // Quiet, bounded backoff. No notifications or logs on retry.
  scheduleRetry(delayMs = this.retryDelay) {
    if (!this.persistent || !this.running || this.retryTimer) return;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = undefined;
      this.retryDelay = Math.min(this.retryDelay * 2, 5000);
      void this.start().catch(() => this.scheduleRetry());
    }, delayMs + Math.floor(Math.random() * 50));
    this.retryTimer.unref?.();
  }

  settle(message) {
    const pending = this.pending.get(message.id);
    if (!pending) return; // Late response to a cancelled/expired request.
    if (message.error) pending.reject(new Error(String(message.error).slice(0, 500)));
    else pending.resolve(message.result);
  }

  async request(op, args = {}, { signal, timeout = 15_000 } = {}) {
    signal?.throwIfAborted();
    const epoch = this.epoch;
    const until = Date.now() + Math.min(timeout, 8000);
    // Wait only BEFORE dispatch. Never replay an action after a lost connection.
    while (this.persistent && this.running && this.epoch === epoch &&
           !this.browserReady() && Date.now() < until) {
      await delay(Math.min(100, Math.max(1, until - Date.now())), undefined, { signal });
    }
    signal?.throwIfAborted();
    const target = this.mode === 'hub' ? this.peer : this.hub;
    if (!this.running || this.epoch !== epoch || !this.browserReady() || !target) {
      throw new Error(NOT_CONNECTED);
    }
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      const finish = (fn, value) => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', abort);
        this.pending.delete(id);
        fn(value);
      };
      const cancel = (error) => {
        send(target, { type: 'cancel', id });
        finish(reject, error);
      };
      const abort = () => cancel(new Error('Browser request cancelled; read before retrying any action.'));
      const timer = setTimeout(() => cancel(new Error('Browser request timed out; read before retrying any action.')), timeout);
      this.pending.set(id, {
        resolve: (value) => finish(resolve, value),
        reject: (error) => finish(reject, error),
      });
      signal?.addEventListener('abort', abort, { once: true });
      target.send(JSON.stringify({ type: 'command', id, op, args, expiresAt: Date.now() + timeout,
        ...(this.mode === 'hub' ? { session: this.session } : {}) }));
    });
  }

  rejectPending(reason) {
    for (const pending of [...this.pending.values()]) pending.reject(new Error(reason));
  }

  async close({ revoke = false } = {}) {
    this.running = false;
    this.epoch++;
    clearTimeout(this.retryTimer);
    this.retryTimer = undefined;
    if (this.mode === 'client') {
      const hub = this.hub;
      this.hub = null;
      this.mode = undefined;
      this.browserConnected = false;
      if (revoke) send(hub, { type: 'revoke' }); // The hub tells Chrome to forget pairing.
      this.rejectPending('Browser bridge stopped');
      hub?.close(1000);
      this.pairing = undefined;
      this.token = undefined;
      return;
    }
    if (!this.server) return;
    this.rejectPending('Browser bridge stopped');
    for (const ws of this.sockets) {
      if (revoke && !this.sessions.has(ws) && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'revoke' }));
        ws.close(1000, 'revoked');
      } else ws.terminate(); // Joined sessions see the close and one takes the port over.
    }
    this.peer = null;
    this.mode = undefined;
    this.sessions.clear();
    this.routes.clear();
    await new Promise((resolve) => this.wss.close(resolve));
    // close() stops accepting immediately. The standalone Pi runtime can leave
    // its HTTP close callback pending after upgrades, so don't await it.
    this.server.close();
    this.server.closeAllConnections();
    this.server = undefined;
    this.wss = undefined;
    this.pairing = undefined;
    this.token = undefined;
  }

  async reset() {
    return this.transition(async () => {
      if (this.mode === 'client') {
        // The port owner revokes Chrome and rotates the token for every session.
        send(this.hub, { type: 'reset' });
        await this.close();
        return;
      }
      // Remove the credential before releasing the port, so a session that takes
      // the port over creates a fresh token instead of saving the old one again.
      if (this.persistent) {
        try { await unlink(this.statePath); } catch (error) {
          if (error.code !== 'ENOENT') throw error;
        }
      }
      await this.close({ revoke: true });
    });
  }
}
