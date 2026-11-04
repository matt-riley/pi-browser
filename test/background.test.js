import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';

// Load the extension worker against a minimal fake of the Chrome APIs it touches at startup.
async function startWorker({ stored, origins }) {
  const calls = [];
  const event = { addListener() {} };
  globalThis.chrome = {
    storage: {
      session: { get: async () => ({}), set: async () => {}, clear: async () => {} },
      local: { get: async () => ({ ...stored }), set: async () => {}, remove: async (key) => { calls.push(['storage.remove', key]); } },
    },
    permissions: {
      getAll: async () => ({ origins: [...origins], permissions: ['activeTab', 'alarms', 'scripting', 'storage', 'tabs'] }),
      remove: async (request) => { calls.push(['permissions.remove', request]); return true; },
    },
    action: { setBadgeBackgroundColor: async () => {}, setBadgeText: async () => {} },
    alarms: { get: async () => undefined, create: async () => {}, clear: async () => true, onAlarm: event },
    runtime: { id: 'fixture', getURL: (path) => path, onStartup: event, onMessage: event, onSuspend: event },
    tabs: { onRemoved: event, onUpdated: event },
  };
  await import(`../chrome/background.js?worker=${Math.random()}`);
  await delay(20);
  delete globalThis.chrome;
  return calls;
}

test('on load, a stored allowed-sites list and the site permissions it granted are removed', async () => {
  const calls = await startWorker({
    stored: { policies: [{ origin: 'https://github.com', actions: ['click', 'navigate', 'read'] }] },
    origins: ['https://github.com/*'],
  });
  assert.deepEqual(calls, [
    ['storage.remove', 'policies'],
    ['permissions.remove', { origins: ['https://github.com/*'] }],
  ]);
});

test('with nothing left over, load removes no site permissions', async () => {
  const calls = await startWorker({ stored: {}, origins: [] });
  assert.deepEqual(calls, [['storage.remove', 'policies']]);
});
