let socket = null;
let connected = false;
let heartbeat;
let reconnectTimer;
let reconnectDelay = 1000;
let pairingProfile = null;
// tabId -> { origin, id }. Only tabs the user shares from the popup are usable,
// and every connected Pi session may use every shared tab.
const shared = new Map();
// Pi sessions connected through the bridge, as announced by the port owner. Shown in the popup.
let sessions = [];
const queues = new Map();
const requests = new Map();
let controls = Promise.resolve();
let controlEpoch = 0;
const TOKEN = /^[a-f0-9]{64}$/;
const SESSION = /^[A-Za-z0-9-]{1,100}$/;
const RECONNECT_ALARM = 'pi-browser-reconnect';
async function ensureReconnectAlarm() {
  const alarm = await chrome.alarms.get(RECONNECT_ALARM);
  if (pairingProfile && !alarm) {
    await chrome.alarms.create(RECONNECT_ALARM, { periodInMinutes: 1 });
  }
}
function forgetPairing() {
  pairingProfile = null;
  void chrome.storage.local.remove('pairing');
  void chrome.alarms.clear(RECONNECT_ALARM);
  disconnect();
}
const status = () => ({ connected, paired: Boolean(pairingProfile), shares: [...shared.keys()],
  sessions: sessions.map((session) => ({ ...session })) });
const validSessions = (list) => (Array.isArray(list) ? list.slice(0, 32) : [])
  .filter((item) => SESSION.test(item?.id ?? '') && typeof item.label === 'string')
  .map(({ id, label }) => ({ id, label: label.slice(0, 100) }));

const badge = (tabId, text) => chrome.action.setBadgeText({ tabId, text }).catch(() => {});
const persist = () => chrome.storage.session.set({ shares: [...shared.keys()] });

function dropTab(tabId) {
  shared.delete(tabId); // Revoke synchronously before awaiting Chrome APIs.
  void badge(tabId, '');
  void persist();
  void chrome.tabs.sendMessage(tabId, { type: 'dom_revoke' }).catch(() => {});
}
function cancelRequests() {
  for (const request of requests.values()) request.cancelled = true;
}
function disconnect({ reconnect = false } = {}) {
  controlEpoch++;
  connected = false;
  clearInterval(heartbeat);
  clearTimeout(reconnectTimer);
  reconnectTimer = undefined;
  const old = socket;
  socket = null;
  sessions = [];
  for (const id of [...shared.keys()]) dropTab(id);
  cancelRequests();
  old?.close();
  if (reconnect) scheduleReconnect();
}
function socketClosed(ws, shouldReconnect) {
  if (socket !== ws) return;
  controlEpoch++;
  connected = false;
  clearInterval(heartbeat);
  socket = null;
  sessions = [];
  for (const id of [...shared.keys()]) dropTab(id);
  cancelRequests();
  if (shouldReconnect) scheduleReconnect();
}
function scheduleReconnect(delay = reconnectDelay) {
  if (!pairingProfile || connected || socket || reconnectTimer) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = undefined;
    if (!pairingProfile || connected || socket) return;
    void pair(pairingProfile.port, pairingProfile.token, { automatic: true }).catch(() => {
      reconnectDelay = Math.min(reconnectDelay * 2, 30_000);
      scheduleReconnect();
    });
  }, delay);
}

async function pair(port, token, { automatic = false } = {}) {
  if (!Number.isInteger(port) || port < 1 || port > 65535 || !TOKEN.test(token ?? '')) {
    throw new Error('Enter the port and 64-character token shown by /browser');
  }
  disconnect();
  const ws = new WebSocket(`ws://127.0.0.1:${port}/browser`);
  socket = ws;
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { ws.close(); reject(new Error('Pairing timed out')); }, 6000);
    let paired = false;
    let lastPong = Date.now();
    ws.onopen = () => ws.send(JSON.stringify({ type: 'pair', token }));
    ws.onmessage = async (event) => {
      if (socket !== ws) return;
      let message;
      try { message = JSON.parse(event.data); } catch { disconnect(); return; }
      if (message.type === 'paired' && !paired) {
        paired = true;
        connected = true;
        reconnectDelay = 1000;
        pairingProfile = { port, token };
        sessions = validSessions(message.sessions);
        clearTimeout(timer);
        heartbeat = setInterval(() => {
          if (Date.now() - lastPong > 45_000) { disconnect({ reconnect: true }); return; }
          if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'ping' }));
        }, 20_000);
        try {
          await chrome.storage.local.set({ pairing: pairingProfile });
          if (socket !== ws) throw new Error('Pairing cancelled');
          await ensureReconnectAlarm();
          resolve();
        } catch (error) {
          reject(error);
        }
      } else if (paired && message.type === 'pong') {
        lastPong = Date.now();
      } else if (paired && message.type === 'sessions') {
        sessions = validSessions(message.sessions);
      } else if (paired && message.type === 'revoke') {
        forgetPairing();
      } else if (paired && message.type === 'command') {
        void execute(message, ws);
      } else if (message.type === 'cancel') {
        const request = requests.get(message.id);
        if (request) request.cancelled = true;
      }
    };
    ws.onerror = () => { clearTimeout(timer); reject(new Error('Cannot connect; run /browser first')); };
    ws.onclose = () => {
      clearTimeout(timer);
      socketClosed(ws, paired || automatic || Boolean(pairingProfile));
      if (!paired) reject(new Error('Pairing refused or browser bridge disconnected'));
    };
  });
}

function check(request, ws) {
  if (!connected || socket !== ws || request.cancelled || Date.now() >= request.expiresAt) {
    throw new Error('Request cancelled, disconnected or expired');
  }
}
async function approvedTab(tabId, grant) {
  const current = shared.get(tabId);
  if (grant && current !== grant) throw new Error('Tab sharing revoked');
  if (!current) throw new Error('Tab not shared. Share it from the Pi Browser popup first.');
  const tab = await chrome.tabs.get(tabId);
  if (!tab.url) throw new Error('Tab has no usable URL');
  let url;
  try { url = new URL(tab.url); } catch { throw new Error('Tab URL is invalid'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('Only ordinary HTTP(S) tabs are supported');
  // Chrome ends the popup's access when a tab moves to another site, so sharing ends too.
  if (current.origin !== url.origin) {
    dropTab(tabId);
    throw new Error('Tab moved to another site, so it is no longer shared. Share it again from the Pi Browser popup.');
  }
  return { tab, grant: current };
}
async function dom(tabId, grant, type, args, request, ws) {
  const initial = await approvedTab(tabId, grant);
  check(request, ws);
  await chrome.scripting.executeScript({ target: { tabId }, files: ['content.js'] });
  const current = await approvedTab(tabId, initial.grant);
  check(request, ws);
  const response = await chrome.tabs.sendMessage(tabId, {
    ...args, type, grantId: current.grant.id, origin: current.grant.origin, expiresAt: request.expiresAt,
  }, { frameId: 0 });
  if (!response || response.error) throw new Error(response?.error ?? 'No DOM response');
  check(request, ws);
  return response.result;
}
async function waitForComplete(tabId, request, ws) {
  const until = Math.min(Date.now() + 5000, request.expiresAt);
  while (Date.now() < until) {
    const tab = await chrome.tabs.get(tabId);
    check(request, ws);
    if (tab.status === 'complete') return tab;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('Page still loading; read it again later');
}
async function observeAfterClick(tabId, grant, request, ws) {
  // Bounded wait, no action retries. This is an observation, not proof of goal completion.
  await new Promise((resolve) => setTimeout(resolve, 250));
  const until = Math.min(Date.now() + 5000, request.expiresAt);
  while (Date.now() < until) {
    const { tab } = await approvedTab(tabId, grant);
    check(request, ws);
    if (tab.status === 'complete') return dom(tabId, grant, 'dom_summary', {}, request, ws);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('Page still loading; read it again later');
}
async function listTabs() {
  const tabs = await chrome.tabs.query({});
  const result = [];
  for (const tab of tabs) {
    if (!Number.isSafeInteger(tab.id) || !tab.url) continue;
    let origin;
    try { origin = new URL(tab.url).origin; } catch { continue; }
    const explicit = shared.get(tab.id);
    if (explicit && explicit.origin === origin) {
      result.push({ tabId: tab.id, title: (tab.title ?? '').slice(0, 300), url: tab.url.slice(0, 2048) });
    }
  }
  return result;
}
async function run(message, request, ws) {
  await ready;
  check(request, ws);
  const { op, args = {} } = message;
  if (op === 'tabs') {
    const tabs = await listTabs();
    check(request, ws);
    return tabs;
  }
  const tabId = args.tabId;
  if (!Number.isSafeInteger(tabId)) throw new Error('Invalid tab ID');
  const grant = shared.get(tabId);
  if (op === 'read') return dom(tabId, grant, 'dom_read', {}, request, ws);
  if (op === 'query' || op === 'query_validate') {
    return dom(tabId, grant, op === 'query' ? 'dom_query' : 'dom_query_validate', {
      question: args.question, claim: args.claim, cursor: args.cursor, snapshotId: args.snapshotId,
    }, request, ws);
  }
  if (op === 'candidates') {
    if (typeof args.goal !== 'string' || !args.goal.trim() || args.goal.length > 2000) throw new Error('Invalid navigation goal');
    return dom(tabId, grant, 'dom_candidates', { goal: args.goal }, request, ws);
  }
  // Every click is approved by the user in the Pi session that asked for it.
  if (op !== 'click' || args.approved !== true || typeof args.snapshotId !== 'string' || typeof args.candidateId !== 'string') {
    throw new Error('Unsupported or unapproved browser action');
  }
  const clicked = await dom(tabId, grant, 'dom_click', { snapshotId: args.snapshotId, candidateId: args.candidateId, approved: true }, request, ws);
  try {
    return { ...clicked, page: await observeAfterClick(tabId, shared.get(tabId), request, ws) };
  } catch (error) {
    return { ...clicked, observationError: error.message };
  }
}
async function execute(message, ws) {
  if (typeof message.id !== 'string' || requests.has(message.id) ||
      !Number.isFinite(message.expiresAt) || message.expiresAt > Date.now() + 30_000) return;
  const request = { expiresAt: message.expiresAt, cancelled: false };
  requests.set(message.id, request);
  const key = message.args?.tabId ?? 'tabs';
  const work = (queues.get(key) ?? Promise.resolve()).catch(() => {}).then(() => run(message, request, ws));
  queues.set(key, work);
  try {
    const result = await work;
    const response = JSON.stringify({ type: 'result', id: message.id, result });
    if (new TextEncoder().encode(response).length > 120_000) throw new Error('Result exceeds browser context budget; narrow the page/tab set. Do not retry an action without reading first.');
    if (socket === ws && ws.readyState === WebSocket.OPEN) ws.send(response);
  } catch (error) {
    if (socket === ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'result', id: message.id, error: error.message }));
  } finally {
    requests.delete(message.id);
    if (queues.get(key) === work) queues.delete(key);
  }
}

// Unexpected worker restart fails closed for shared tabs, but pairing survives.
const startupEpoch = controlEpoch;
const ready = (async () => {
  const { shares = [] } = await chrome.storage.session.get('shares');
  await Promise.all(shares.map((id) => badge(id, '')));
  await chrome.storage.session.clear();
  const stored = await chrome.storage.local.get('pairing');
  if (controlEpoch === startupEpoch && stored.pairing && Number.isInteger(stored.pairing.port) && TOKEN.test(stored.pairing.token ?? '')) {
    pairingProfile = { port: stored.pairing.port, token: stored.pairing.token };
  }
  // Older versions kept an allowed-sites list and Chrome site permissions for it.
  // Nothing uses either now, so forget both rather than leave access behind.
  await chrome.storage.local.remove('policies');
  const { origins = [] } = await chrome.permissions.getAll();
  if (origins.length) await chrome.permissions.remove({ origins }).catch(() => {});
  await chrome.action.setBadgeBackgroundColor({ color: '#b42318' });
  if (pairingProfile) {
    await ensureReconnectAlarm();
    scheduleReconnect(0);
  } else await chrome.alarms.clear(RECONNECT_ALARM);
})();

// Timers cannot wake an MV3 worker. An alarm/startup event can; neither grants access.
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === RECONNECT_ALARM) void ready.then(() => scheduleReconnect(0));
});
chrome.runtime.onStartup.addListener(() => {
  void ready.then(async () => { await ensureReconnectAlarm(); scheduleReconnect(0); });
});

chrome.runtime.onMessage.addListener((message, sender, reply) => {
  // Only extension UI may pair/share/revoke. Content scripts cannot grant themselves access.
  if (sender.id !== chrome.runtime.id || sender.url !== chrome.runtime.getURL('popup.html')) return;
  // STOP bypasses pending controls so a stalled pair/share cannot delay revocation.
  if (message?.type === 'stop') {
    forgetPairing();
    reply({ result: status() });
    return;
  }
  const epoch = controlEpoch;
  const work = controls.catch(() => {}).then(async () => {
    await ready;
    if (message?.type === 'status') { scheduleReconnect(0); return status(); }
    if (epoch !== controlEpoch) throw new Error('Popup request cancelled by disconnect; try again');
    if (message?.type === 'pair') await pair(message.port, message.token);
    else if (message?.type === 'share') {
      if (!connected) throw new Error('Pair with Pi before sharing a tab');
      const tab = await chrome.tabs.get(message.tabId);
      const url = new URL(tab.url);
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('Only ordinary HTTP(S) tabs can be shared');
      if (shared.size >= 254 && !shared.has(tab.id)) throw new Error('At most 254 tabs can be shared');
      await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['content.js'] });
      if (!connected) throw new Error('Disconnected while sharing');
      shared.set(tab.id, { origin: url.origin, id: crypto.randomUUID() });
      await badge(tab.id, 'ON');
      await persist();
    } else if (message?.type === 'revoke') dropTab(message.tabId);
    else if (message?.type !== 'status') throw new Error('Unknown popup request');
    return status();
  });
  controls = work;
  work.then((result) => reply({ result }), (error) => reply({ error: error.message }));
  return true;
});
chrome.tabs.onRemoved.addListener((id) => dropTab(id));
chrome.tabs.onUpdated.addListener((id, change) => {
  const grant = shared.get(id);
  if (grant && change.url) {
    let origin;
    try { origin = new URL(change.url).origin; } catch { dropTab(id); return; }
    if (origin !== grant.origin) dropTab(id);
  }
});
chrome.runtime.onSuspend.addListener(() => disconnect());
