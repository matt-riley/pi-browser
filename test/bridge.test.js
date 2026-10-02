import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, rm, stat } from 'node:fs/promises';
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
    assert.equal(JSON.parse((await message)[0]).type, 'paired');
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
