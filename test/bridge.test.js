import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocket } from 'ws';
import { Bridge } from '../src/bridge.ts';

const origin = `chrome-extension://${'a'.repeat(32)}`;
export async function connect(bridge, { token = bridge.pairing.token, headers = {}, sendPair = true } = {}) {
  const ws = new WebSocket(`ws://127.0.0.1:${bridge.pairing.port}/browser`, { origin, headers });
  await once(ws, 'open');
  if (sendPair) {
    const message = once(ws, 'message');
    ws.send(JSON.stringify({ type: 'pair', token }));
    ws.paired = JSON.parse((await message)[0]);
    assert.equal(ws.paired.type, 'paired');
  }
  return ws;
}
async function fixture(t) {
  const bridge = new Bridge();
  await bridge.start();
  t.after(() => bridge.stop());
  return bridge;
}

test('binds loopback, pairs one peer and delivers RPC responses', async (t) => {
  const bridge = await fixture(t);
  assert.equal(bridge.server.address().address, '127.0.0.1');
  assert.equal(bridge.pairing.token.length, 64);
  const ws = await connect(bridge);
  const command = once(ws, 'message');
  const result = bridge.request('tabs');
  const message = JSON.parse((await command)[0]);
  assert.equal(message.op, 'tabs');
  ws.send(JSON.stringify({ type: 'result', id: message.id, result: [] }));
  assert.deepEqual(await result, []);
});
test('website origins and rebound hosts cannot upgrade', async (t) => {
  const bridge = await fixture(t);
  for (const options of [{ origin: 'https://evil.example' }, { origin, headers: { Host: 'evil.example' } }]) {
    const ws = new WebSocket(`ws://127.0.0.1:${bridge.pairing.port}/browser`, options);
    await once(ws, 'error');
    assert.equal(bridge.peer, null);
  }
});
test('wrong token, invalid JSON and a second peer are refused', async (t) => {
  const bridge = await fixture(t);
  const bad = await connect(bridge, { sendPair: false });
  const closed = once(bad, 'close');
  bad.send(JSON.stringify({ type: 'pair', token: '0'.repeat(64) }));
  assert.equal((await closed)[0], 1008);
  const junk = await connect(bridge, { sendPair: false });
  const junkClosed = once(junk, 'close');
  junk.send('{');
  assert.equal((await junkClosed)[0], 1008);
  await connect(bridge);
  const second = await connect(bridge, { sendPair: false });
  const secondClosed = once(second, 'close');
  second.send(JSON.stringify({ type: 'pair', token: bridge.pairing.token }));
  assert.equal((await secondClosed)[0], 1008);
});
test('cancellation and timeouts remove pending calls without retrying', async (t) => {
  const bridge = await fixture(t);
  const ws = await connect(bridge);
  const frames = [];
  ws.on('message', (raw) => frames.push(JSON.parse(raw)));
  const controller = new AbortController();
  const pending = bridge.request('click', {}, { signal: controller.signal });
  controller.abort();
  await assert.rejects(pending, /cancelled/);
  await assert.rejects(bridge.request('read', {}, { timeout: 20 }), /timed out/);
  assert.equal(bridge.pending.size, 0);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(frames.filter((f) => f.type === 'command').length, 2);
  assert.equal(frames.filter((f) => f.type === 'cancel').length, 2);
});
test('overlapping lifecycle callers serialize and shutdown stays idempotent', async () => {
  const bridge = new Bridge();
  const [first, second] = await Promise.all([bridge.start(), bridge.start()]);
  assert.deepEqual(first, second);
  await Promise.all([bridge.stop(), bridge.stop()]);
  assert.equal(bridge.server, undefined);
  await Promise.all([bridge.start(), bridge.stop()]);
  assert.equal(bridge.server, undefined);
});

test('persistent pairing reuses credentials, survives restart, and resets with restrictive permissions', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'pi-browser-credentials-'));
  const statePath = join(directory, 'credentials.json');
  t.after(() => rm(directory, { recursive: true, force: true }));
  const first = new Bridge({ persistent: true, statePath, port: 0 });
  await first.start();
  const pairing = first.pairing;
  await first.stop();
  const mode = (await stat(statePath)).mode & 0o777;
  assert.equal(mode, 0o600);
  const second = new Bridge({ persistent: true, statePath, port: pairing.port });
  await second.start();
  assert.deepEqual(second.pairing, pairing);
  await second.reset();
  const third = new Bridge({ persistent: true, statePath, port: pairing.port });
  await third.start();
  assert.notEqual(third.pairing.token, pairing.token);
  await third.stop();
});

test('persistent bridge waits for reconnect only before dispatch and respects stop/cancellation', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'pi-browser-reconnect-'));
  const bridge = new Bridge({ persistent: true, statePath: join(directory, 'credentials.json'), port: 0 });
  await bridge.start();
  t.after(async () => { await bridge.stop(); await rm(directory, { recursive: true, force: true }); });
  const result = bridge.request('tabs', {}, { timeout: 1000 });
  const ws = await connect(bridge);
  let commands = 0;
  ws.on('message', (raw) => {
    const message = JSON.parse(raw);
    if (message.type !== 'command') return;
    commands++;
    ws.send(JSON.stringify({ type: 'result', id: message.id, result: [] }));
  });
  assert.deepEqual(await result, []);
  assert.equal(commands, 1);
  const closed = once(ws, 'close');
  ws.close();
  await closed;
  const controller = new AbortController();
  const cancelled = bridge.request('click', {}, { signal: controller.signal, timeout: 1000 });
  controller.abort();
  await assert.rejects(cancelled, { name: 'AbortError' });
  const stopped = bridge.request('click', {}, { timeout: 1000 });
  const rejection = assert.rejects(stopped, /disconnected/);
  await bridge.stop();
  await rejection;
  assert.equal(commands, 1, 'neither cancelled nor stopped calls may dispatch');
});

test('disconnect and stop reject pending calls, and restarting rotates the secret', async (t) => {
  const bridge = await fixture(t);
  const token = bridge.pairing.token;
  const ws = await connect(bridge);
  const pending = bridge.request('read');
  ws.close();
  await assert.rejects(pending, /disconnected/);
  await bridge.stop();
  await bridge.stop();
  await bridge.start();
  assert.notEqual(bridge.pairing.token, token);
  await connect(bridge);
  const next = bridge.request('read');
  const rejection = assert.rejects(next, /stopped/);
  await bridge.stop();
  await rejection;
});

// Several Pi sessions share one saved port: the first binds it, the rest join it.
async function sessionsFixture(t, count = 3) {
  const directory = await mkdtemp(join(tmpdir(), 'pi-browser-sessions-'));
  const statePath = join(directory, 'credentials.json');
  const bridges = [];
  t.after(async () => {
    for (const bridge of bridges) await bridge.stop();
    await rm(directory, { recursive: true, force: true });
  });
  const first = new Bridge({ persistent: true, statePath, port: 0 });
  bridges.push(first);
  await first.start();
  for (let i = 1; i < count; i++) {
    const next = new Bridge({ persistent: true, statePath, port: first.pairing.port });
    bridges.push(next);
    await next.start();
  }
  return bridges;
}
async function waitFor(check, what, ms = 4000) {
  const until = Date.now() + ms;
  while (!check()) {
    if (Date.now() > until) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
function fakeChrome(ws, { reply = true } = {}) {
  const seen = { commands: [], cancels: [], sessions: [] };
  ws.on('message', (raw) => {
    const message = JSON.parse(raw);
    if (message.type === 'sessions') seen.sessions.push(message.sessions);
    if (message.type === 'cancel') seen.cancels.push(message.id);
    if (message.type !== 'command') return;
    seen.commands.push(message);
    if (reply) ws.send(JSON.stringify({ type: 'result', id: message.id, result: message.args }));
  });
  return seen;
}
function quiet(t) {
  const lines = [];
  for (const name of ['log', 'warn', 'error']) {
    const original = console[name];
    console[name] = (...args) => lines.push(args.join(' '));
    t.after(() => { console[name] = original; });
  }
  return lines;
}

test('several Pi sessions connect at once, each gets its own replies, and nothing is evicted or logged', async (t) => {
  const logs = quiet(t);
  const bridges = await sessionsFixture(t, 3);
  assert.equal(new Set(bridges.map((bridge) => bridge.pairing.port)).size, 1);
  assert.equal(new Set(bridges.map((bridge) => bridge.pairing.token)).size, 1);
  const chrome = await connect(bridges[0]);
  const seen = fakeChrome(chrome);
  const results = await Promise.all(bridges.map((bridge) => bridge.request('tabs', { who: bridge.session }, { timeout: 2000 })));
  assert.deepEqual(results.map((result) => result.who), bridges.map((bridge) => bridge.session));
  // Every session may use every shared tab, so Chrome isn't told which session asked.
  assert.ok(seen.commands.every((command) => command.session === undefined));
  assert.equal(chrome.readyState, WebSocket.OPEN, 'Chrome must not be evicted by other sessions');
  const announced = seen.sessions.at(-1) ?? chrome.paired.sessions;
  assert.deepEqual(announced.map((session) => session.id).sort(), bridges.map((bridge) => bridge.session).sort());
  assert.ok(announced.every((session) => typeof session.label === 'string' && session.label.length > 0));
  assert.ok(bridges.every((bridge) => bridge.browserReady()));
  assert.deepEqual(logs, []);
});

test('a joining session cannot reuse another session id or skip the token', async (t) => {
  const [hub] = await sessionsFixture(t, 1);
  for (const join of [{ type: 'join', token: hub.pairing.token, session: hub.session, label: 'spoof' },
    { type: 'join', token: '0'.repeat(64), session: 'other', label: 'bad token' }]) {
    const ws = new WebSocket(`ws://127.0.0.1:${hub.pairing.port}/pi`);
    await once(ws, 'open');
    const closed = once(ws, 'close');
    ws.send(JSON.stringify(join));
    assert.equal((await closed)[0], 1008);
  }
  // Web pages always send an Origin header, so they cannot use the Pi path.
  const page = new WebSocket(`ws://127.0.0.1:${hub.pairing.port}/pi`, { origin: 'https://evil.example' });
  await once(page, 'error');
});

test('closing one session cancels only its in-flight commands and leaves the others working', async (t) => {
  const [hub, left, stays] = await sessionsFixture(t, 3);
  const chrome = await connect(hub);
  const seen = fakeChrome(chrome, { reply: false });
  const pending = left.request('click', {}, { timeout: 2000 });
  const rejection = assert.rejects(pending, /disconnected|stopped/);
  await waitFor(() => seen.commands.length === 1, 'the click to reach Chrome');
  await left.stop();
  await rejection;
  await waitFor(() => seen.cancels.includes(seen.commands[0].id), 'Chrome to get a cancel');
  await waitFor(() => seen.sessions.at(-1)?.length === 2, 'the closed session to leave');
  const kept = stays.request('tabs', { who: stays.session }, { timeout: 2000 });
  await waitFor(() => seen.commands.length === 2, 'the remaining session to reach Chrome');
  chrome.send(JSON.stringify({ type: 'result', id: seen.commands[1].id, result: 'ok' }));
  assert.equal(await kept, 'ok');
  assert.equal(seen.commands[1].args.who, stays.session);
});

test('when the port owner exits another session takes over without replaying in-flight actions', async (t) => {
  const logs = quiet(t);
  const [hub, heir] = await sessionsFixture(t, 2);
  const chrome = await connect(hub);
  const seen = fakeChrome(chrome, { reply: false });
  const pending = heir.request('click', {}, { timeout: 4000 });
  const rejection = assert.rejects(pending, /disconnected/);
  await waitFor(() => seen.commands.length === 1, 'the click to reach Chrome');
  const closed = once(chrome, 'close');
  await hub.stop();
  await rejection;
  await closed;
  await waitFor(() => heir.mode === 'hub', 'the remaining session to own the port');
  assert.equal(heir.pairing.port, hub.pairing?.port ?? heir.pairing.port);
  const again = await connect(heir);
  fakeChrome(again);
  assert.deepEqual(await heir.request('tabs', { who: heir.session }, { timeout: 2000 }), { who: heir.session });
  assert.equal(seen.commands.length, 1, 'the in-flight click must not be replayed');
  assert.deepEqual(logs, []);
});

test('/browser stop in a joined session leaves only that session; Chrome stays paired for the rest', async (t) => {
  const [hub, leaver, stays] = await sessionsFixture(t, 3);
  const chrome = await connect(hub);
  const frames = [];
  chrome.on('message', (raw) => frames.push(JSON.parse(raw)));
  fakeChrome(chrome);
  assert.equal(await leaver.stop({ revoke: true }), false);
  await waitFor(() => frames.some((frame) => frame.type === 'sessions' && frame.sessions.length === 2), 'the session to leave');
  assert.equal(chrome.readyState, WebSocket.OPEN);
  assert.ok(!frames.some((frame) => frame.type === 'revoke'), 'Chrome must not be told to forget pairing');
  assert.deepEqual(await stays.request('tabs', { who: stays.session }, { timeout: 2000 }), { who: stays.session });
  assert.equal(leaver.mode, undefined);
});

test('/browser stop in the hub hands over to another session without revoking Chrome', async (t) => {
  const [hub, heir] = await sessionsFixture(t, 2);
  const chrome = await connect(hub);
  const frames = [];
  chrome.on('message', (raw) => frames.push(JSON.parse(raw)));
  const closed = once(chrome, 'close');
  assert.equal(await hub.stop({ revoke: true }), false);
  await closed;
  assert.ok(!frames.some((frame) => frame.type === 'revoke'), 'Chrome must keep its pairing for the other sessions');
  await waitFor(() => heir.mode === 'hub', 'the remaining session to own the port');
  const again = await connect(heir);
  fakeChrome(again);
  assert.deepEqual(await heir.request('tabs', { who: heir.session }, { timeout: 2000 }), { who: heir.session });
});

test('/browser stop in the only session revokes the Chrome pairing', async (t) => {
  const [only] = await sessionsFixture(t, 1);
  const chrome = await connect(only);
  const revoked = once(chrome, 'message');
  assert.equal(await only.stop({ revoke: true }), true);
  assert.equal(JSON.parse((await revoked)[0]).type, 'revoke');
});

test('/browser reset refuses while other sessions are connected and changes nothing', async (t) => {
  const [hub, other] = await sessionsFixture(t, 2);
  const chrome = await connect(hub);
  const frames = [];
  chrome.on('message', (raw) => frames.push(JSON.parse(raw)));
  fakeChrome(chrome);
  const { token, port } = hub.pairing;
  const saved = await readFile(hub.statePath, 'utf8');
  for (const session of [hub, other]) {
    const result = await session.reset();
    assert.equal(result.reset, false);
    assert.match(result.message, /Other Pi sessions are connected.*Run \/browser stop in them first, then reset/);
  }
  assert.match((await hub.reset()).message, /\(1\)/);
  assert.equal(await readFile(hub.statePath, 'utf8'), saved, 'the token must not change');
  assert.deepEqual(hub.pairing, { token, port });
  assert.equal(hub.mode, 'hub');
  assert.equal(other.mode, 'client');
  assert.equal(chrome.readyState, WebSocket.OPEN);
  assert.ok(!frames.some((frame) => frame.type === 'revoke'), 'Chrome must not be told to forget pairing');
  for (const session of [hub, other]) {
    assert.deepEqual(await session.request('tabs', { who: session.session }, { timeout: 2000 }), { who: session.session });
  }
});

test('/browser reset in the only session rotates the token and revokes Chrome', async (t) => {
  const [only] = await sessionsFixture(t, 1);
  const chrome = await connect(only);
  const { token } = only.pairing;
  const revoked = once(chrome, 'message');
  assert.equal((await only.reset()).reset, true);
  assert.equal(JSON.parse((await revoked)[0]).type, 'revoke');
  await assert.rejects(readFile(only.statePath, 'utf8'), { code: 'ENOENT' });
  await only.start();
  assert.notEqual(only.pairing.token, token);
});
