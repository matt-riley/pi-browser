import { chmod, mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { createServer } from 'node:http';
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { WebSocketServer, WebSocket } from 'ws';
import { setTimeout as delay } from 'node:timers/promises';

const DEFAULT_PORT = 37123;
const tokenPattern = /^[a-f0-9]{64}$/;

// One bridge belongs to one Pi session. The secret never enters model context.
export class Bridge {
  pending = new Map();
  sockets = new Set();
  peer = null;

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
  }

  transition(work) {
    const next = (this.lifecycle ?? Promise.resolve()).catch(() => {}).then(work);
    this.lifecycle = next;
    return next;
  }

  start() { return this.transition(() => this.open()); }
  stop(options = {}) { return this.transition(() => this.close(options)); }

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
    if (this.server) return this.pairing;
    const profile = this.persistent ? await this.loadProfile() : {
      token: randomBytes(32).toString('hex'), port: this.port,
    };
    this.token = profile.token;
    const server = createServer((_req, res) => res.writeHead(404).end());
    const wss = new WebSocketServer({ noServer: true, maxPayload: 128 * 1024 });
    this.server = server;
    this.wss = wss;
    server.on('upgrade', (req, socket, head) => {
      const valid = req.url === '/browser' &&
        req.headers.host === `127.0.0.1:${server.address()?.port}` &&
        /^chrome-extension:\/\/[a-p]{32}$/.test(req.headers.origin ?? '') &&
        this.sockets.size < 5;
      if (!valid) return socket.destroy();
      wss.handleUpgrade(req, socket, head, (ws) => this.accept(ws));
    });
    try {
      await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(profile.port, '127.0.0.1', resolve);
      });
      const port = server.address().port;
      await this.saveProfile(this.token, port);
    } catch (error) {
      this.server = undefined;
      this.wss = undefined;
      wss.close();
      server.close();
      server.closeAllConnections();
      throw error;
    }
    this.pairing = { port: server.address().port, token: this.token };
    return this.pairing;
  }

  accept(ws) {
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
        const supplied = Buffer.from(typeof message?.token === 'string' ? message.token : '');
        const expected = Buffer.from(this.token);
        if (message?.type !== 'pair' || supplied.length !== expected.length ||
            !timingSafeEqual(supplied, expected) || this.peer) {
          return ws.close(1008, 'Pairing refused');
        }
        authenticated = true;
        this.peer = ws;
        clearTimeout(authDeadline);
        ws.send(JSON.stringify({ type: 'paired' }));
        return;
      }
      lastSeen = Date.now();
      if (message?.type === 'ping') return ws.send(JSON.stringify({ type: 'pong' }));
      if (message?.type !== 'result' || typeof message.id !== 'string') {
        return ws.close(1008, 'Invalid message');
      }
      const pending = this.pending.get(message.id);
      if (!pending) return; // Late response to a cancelled/expired request.
      if (message.error) pending.reject(new Error(String(message.error).slice(0, 500)));
      else pending.resolve(message.result);
    });
    ws.on('close', () => {
      clearTimeout(authDeadline);
      clearInterval(idle);
      this.sockets.delete(ws);
      if (this.peer === ws) {
        this.peer = null;
        this.rejectPending('Browser disconnected; an in-flight click may have occurred. Read before retrying.');
      }
    });
  }

  async request(op, args = {}, { signal, timeout = 15_000 } = {}) {
    signal?.throwIfAborted();
    const server = this.server;
    const until = Date.now() + Math.min(timeout, 8000);
    // Wait only BEFORE dispatch. Never replay an action after a lost connection.
    while (this.persistent && server && this.server === server &&
           this.peer?.readyState !== WebSocket.OPEN && Date.now() < until) {
      await delay(Math.min(100, Math.max(1, until - Date.now())), undefined, { signal });
    }
    signal?.throwIfAborted();
    const peer = this.peer;
    if (this.server !== server || !peer || peer.readyState !== WebSocket.OPEN) {
      throw new Error('Browser disconnected. Saved pairing reconnects automatically; check /browser and the Chrome popup. Pair only for first setup; do not reset to reconnect.');
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
        if (peer.readyState === WebSocket.OPEN) peer.send(JSON.stringify({ type: 'cancel', id }));
        finish(reject, error);
      };
      const abort = () => cancel(new Error('Browser request cancelled; read before retrying any action.'));
      const timer = setTimeout(() => cancel(new Error('Browser request timed out; read before retrying any action.')), timeout);
      this.pending.set(id, {
        resolve: (value) => finish(resolve, value),
        reject: (error) => finish(reject, error),
      });
      signal?.addEventListener('abort', abort, { once: true });
      peer.send(JSON.stringify({ type: 'command', id, op, args, expiresAt: Date.now() + timeout }));
    });
  }

  rejectPending(reason) {
    for (const pending of [...this.pending.values()]) pending.reject(new Error(reason));
  }

  async close({ revoke = false } = {}) {
    if (!this.server) return;
    if (revoke) {
      for (const ws of this.sockets) {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: 'revoke' }));
          ws.close(1000, 'revoked');
        }
      }
    }
    this.rejectPending('Browser bridge stopped');
    this.peer = null;
    for (const ws of this.sockets) if (!revoke) ws.terminate();
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
      await this.close({ revoke: true });
      if (this.persistent) {
        try { await unlink(this.statePath); } catch (error) {
          if (error.code !== 'ENOENT') throw error;
        }
      }
    });
  }
}
