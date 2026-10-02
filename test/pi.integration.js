import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { cp, mkdtemp, readFile, symlink, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { connect } from 'node:net';
import { once } from 'node:events';
import { WebSocket } from 'ws';

test('installed Pi reloads changed bridge helpers, retains pairing and stops without model calls', { timeout: 20_000 }, async (t) => {
  const stateDir = await mkdtemp(join(tmpdir(), 'pi-browser-pi-'));
  t.after(() => rm(stateDir, { recursive: true, force: true }));
  await cp(resolve('src'), join(stateDir, 'src'), { recursive: true });
  await symlink(resolve('node_modules'), join(stateDir, 'node_modules'));
  await writeFile(join(stateDir, 'package.json'), '{"type":"module"}');
  const bridgePath = join(stateDir, 'src', 'bridge.ts');
  const bridgeSource = await readFile(bridgePath, 'utf8');
  const versionedBridge = (generation) => bridgeSource.replace(
    "ws.send(JSON.stringify({ type: 'paired' }));", `ws.send(JSON.stringify({ type: 'paired', generation: '${generation}' }));`,
  );
  assert.notEqual(versionedBridge('before_reload'), bridgeSource);
  await writeFile(bridgePath, versionedBridge('before_reload'));
  const reloadExtension = join(stateDir, 'reload.js');
  await writeFile(reloadExtension, `export default function(pi) {
    pi.registerCommand('test-browser-reload', { handler: async (_args, ctx) => { await ctx.reload(); } });
  }`);
  const child = spawn('pi', [
    '--offline', '--mode', 'rpc', '--no-session', '--no-extensions', '--no-skills',
    '--no-context-files', '--no-prompt-templates', '--no-themes', '-e', join(stateDir, 'src', 'index.js'), '-e', reloadExtension,
  ], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, PI_BROWSER_STATE_PATH: join(stateDir, 'credentials.json'), PI_BROWSER_PORT: '0' },
  });
  let stderr = '';
  let buffer = '';
  let pairing;
  const pending = new Map();
  let sequence = 0;
  const send = (record) => child.stdin.write(JSON.stringify(record) + '\n');
  const request = (command) => new Promise((resolve, reject) => {
    const id = String(++sequence);
    pending.set(id, { resolve, reject });
    send({ ...command, id });
  });
  child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
  child.on('error', (error) => { for (const p of pending.values()) p.reject(error); });
  child.on('exit', () => { for (const p of pending.values()) p.reject(new Error(`Pi exited early: ${stderr}`)); });
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    buffer += chunk;
    let index;
    while ((index = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, index);
      buffer = buffer.slice(index + 1);
      if (!line.trim()) continue;
      const record = JSON.parse(line);
      if (record.type === 'extension_ui_request' && record.method === 'select') {
        pairing = {
          port: Number(record.title.match(/Port: (\d+)/)[1]),
          token: record.title.match(/Token: ([a-f0-9]{64})/)[1],
        };
        send({ type: 'extension_ui_response', id: record.id, value: 'done' });
      }
      const waiter = pending.get(record.id);
      if (record.type === 'response' && waiter) {
        pending.delete(record.id);
        if (record.success) waiter.resolve(record.data);
        else waiter.reject(new Error(record.error));
      }
    }
  });
  t.after(() => { if (child.exitCode === null) child.kill(); });
  const { commands } = await request({ type: 'get_commands' });
  assert.ok(commands.some((c) => c.name === 'browser' && c.source === 'extension'));
  const started = await request({ type: 'prompt', message: '/browser' });
  assert.equal(started.disposition, 'handled');
  let ws = new WebSocket(`ws://127.0.0.1:${pairing.port}/browser`, { origin: `chrome-extension://${'a'.repeat(32)}` });
  await once(ws, 'open');
  const paired = once(ws, 'message');
  ws.send(JSON.stringify({ type: 'pair', token: pairing.token }));
  assert.equal(JSON.parse((await paired)[0]).generation, 'before_reload');
  await writeFile(bridgePath, versionedBridge('after_reload'));
  const beforeReload = pairing;
  const reloadClosed = once(ws, 'close');
  assert.equal((await request({ type: 'prompt', message: '/test-browser-reload' })).disposition, 'handled');
  await reloadClosed;
  // The test uses an ephemeral port override; tokens, unlike port zero allocations, must persist.
  pairing = JSON.parse(await readFile(join(stateDir, 'credentials.json'), 'utf8'));
  assert.equal(pairing.token, beforeReload.token);
  ws = new WebSocket(`ws://127.0.0.1:${pairing.port}/browser`, { origin: `chrome-extension://${'a'.repeat(32)}` });
  await once(ws, 'open');
  const rePaired = once(ws, 'message');
  ws.send(JSON.stringify({ type: 'pair', token: beforeReload.token }));
  assert.equal(JSON.parse((await rePaired)[0]).generation, 'after_reload',
    'Reload must refresh changed bridge helpers, not just recreate the extension entry');
  const { messages } = await request({ type: 'get_messages' });
  assert.ok(!JSON.stringify(messages).includes(pairing.token), 'Pairing secret must not enter model context');
  const closed = once(ws, 'close');
  assert.equal((await request({ type: 'prompt', message: '/browser stop' })).disposition, 'handled');
  await closed;
  const probe = connect({ host: '127.0.0.1', port: pairing.port });
  probe.on('connect', () => probe.destroy());
  const [error] = await once(probe, 'error');
  assert.equal(error.code, 'ECONNREFUSED', 'Stopped bridge must no longer accept connections');
  const exited = once(child, 'exit');
  child.stdin.end();
  assert.equal((await exited)[0], 0);
  assert.doesNotMatch(stderr, /failed to load|extension error/i);
});
