import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { WebSocket } from 'ws';
import register from '../src/index.js';

test('Pi starts a persistent bridge; explicit pairing and shutdown clean up', async (t) => {
  const temp = await mkdtemp(join(tmpdir(), 'pi-browser-register-'));
  const previous = { path: process.env.PI_BROWSER_STATE_PATH, port: process.env.PI_BROWSER_PORT, token: process.env.PI_BROWSER_TOKEN,
    key: process.env.TYPESAFE_API_KEY };
  process.env.TYPESAFE_API_KEY = 'fixture-no-network';
  process.env.PI_BROWSER_STATE_PATH = join(temp, 'credentials.json');
  process.env.PI_BROWSER_PORT = '0';
  delete process.env.PI_BROWSER_TOKEN;
  t.after(async () => {
    for (const [name, value] of [['PI_BROWSER_STATE_PATH', previous.path], ['PI_BROWSER_PORT', previous.port], ['PI_BROWSER_TOKEN', previous.token], ['TYPESAFE_API_KEY', previous.key]]) {
      if (value === undefined) delete process.env[name]; else process.env[name] = value;
    }
    await rm(temp, { recursive: true, force: true });
  });
  const tools = new Map();
  const commands = new Map();
  const events = new Map();
  register({
    registerTool: (tool) => tools.set(tool.name, tool),
    registerCommand: (name, command) => commands.set(name, command),
    on: (name, handler) => events.set(name, handler),
  });
  assert.deepEqual([...tools.keys()], ['browser_tabs', 'browser_open', 'browser_find_tab', 'browser_read', 'browser_query', 'browser_follow_link']);
  await assert.rejects(readFile(process.env.PI_BROWSER_STATE_PATH), { code: 'ENOENT' });
  await assert.rejects(tools.get('browser_tabs').execute('1', {}, undefined), /disconnected/);
  await assert.rejects(commands.get('browser').handler('', { hasUI: false }), /user interface/);
  let title;
  const ctx = { hasUI: true, ui: { select: async (text) => { title = text; }, notify: () => {} } };
  await events.get('session_start')({}, ctx);
  await commands.get('browser').handler('', ctx);
  t.after(() => events.get('session_shutdown')());
  const port = Number(title.match(/Port: (\d+)/)[1]);
  const token = title.match(/Token: ([a-f0-9]{64})/)[1];
  const ws = new WebSocket(`ws://127.0.0.1:${port}/browser`, { origin: `chrome-extension://${'a'.repeat(32)}` });
  await once(ws, 'open');
  const paired = once(ws, 'message');
  ws.send(JSON.stringify({ type: 'pair', token }));
  await paired;
  ws.on('message', (raw) => {
    const command = JSON.parse(raw);
    if (command.type !== 'command') return;
    const result = command.op === 'query' ? { snapshotId: 'fixture-query', url: 'https://example.com/',
      title: 'TITLE-DO-NOT-ECHO', observedAt: Date.now(), cursor: 0, nextCursor: null,
      totalPassages: 0, textTruncated: false, passages: [] }
      : command.op === 'query_validate' ? { snapshotId: 'fixture-query' } : [];
    ws.send(JSON.stringify({ type: 'result', id: command.id, result }));
  });
  const result = await tools.get('browser_tabs').execute('1', {}, undefined);
  assert.deepEqual(JSON.parse(result.content[0].text), { tabs: [], more: 0 });
  assert.doesNotMatch(JSON.stringify(result), new RegExp(token));
  assert.equal(tools.get('browser_follow_link').annotations.destructiveHint, true);
  assert.equal(tools.get('browser_query').annotations.readOnlyHint, true);
  const queryTool = tools.get('browser_query');
  assert.equal(queryTool.parameters.properties.question.maxLength, 2000);
  assert.match(queryTool.description, /never proves absence/);
  assert.match(queryTool.description, /untrusted source quotes/);
  assert.equal(queryTool.parameters.properties.detail.default, 'compact');
  const compactQuery = await queryTool.execute('query', { tabId: 1, question: 'Status?' });
  const compactData = JSON.parse(compactQuery.content[0].text);
  assert.deepEqual(compactQuery.structuredContent, compactData);
  assert.deepEqual(compactQuery.details, compactData);
  assert.doesNotMatch(JSON.stringify(compactQuery), /TITLE-DO-NOT-ECHO|observedAt|limitation|probabilities/);
  assert.ok(compactQuery.content[0].text.length < 300);
  const expandedQuery = await queryTool.execute('query-detail', { tabId: 1, question: 'Status?',
    snapshotId: compactData.snapshotId, detail: 'evidence' });
  assert.match(expandedQuery.content[0].text, /TITLE-DO-NOT-ECHO/);
  const closed = once(ws, 'close');
  await commands.get('browser').handler('stop', ctx);
  await closed;
  await assert.rejects(tools.get('browser_tabs').execute('2', {}, undefined), /disconnected/);
  // A new factory can be loaded while the old runtime still owns the saved port.
  await commands.get('browser').handler('', ctx);
  const reloadPort = Number(title.match(/Port: (\d+)/)[1]);
  process.env.PI_BROWSER_PORT = String(reloadPort);
  const nextEvents = new Map();
  const nextCommands = new Map();
  register({ registerTool() {}, registerCommand: (name, command) => nextCommands.set(name, command),
    on: (name, handler) => nextEvents.set(name, handler) });
  t.after(() => nextEvents.get('session_shutdown')());
  // Even a real port conflict must be retryable, not poison this runtime permanently.
  let warning;
  await nextEvents.get('session_start')({}, { ui: { notify: (message) => { warning = message; } } });
  assert.match(warning, /EADDRINUSE/);
  await events.get('session_shutdown')();
  await nextEvents.get('session_start')({}, ctx);
  await nextCommands.get('browser').handler('', ctx);
  assert.equal(Number(title.match(/Port: (\d+)/)[1]), reloadPort);
  assert.equal(title.match(/Token: ([a-f0-9]{64})/)[1], token);
  await nextCommands.get('browser').handler('reset', ctx);
  await events.get('session_shutdown')();
});
