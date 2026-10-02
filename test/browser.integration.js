import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, cp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { chromium } from 'playwright';
import { Bridge } from '../src/bridge.ts';
import { Browser } from '../src/browser.ts';
import { createJev } from '../src/selection.ts';

const fixtureHTML = `<!doctype html><html><head><title>Project dashboard</title></head><body>
<h1>Project dashboard</h1><p>Manage your project and inspect deployment activity.</p>
<a href="/settings">Settings</a><a href="/deployments">Deployments</a>
<a href="/hidden" hidden>Hidden</a><a href="/invisible" style="opacity:0">Invisible</a>
<a href="https://elsewhere.example/">Other site</a><a href="javascript:alert(1)">Script</a>
<a href="/download" download>Download</a><a href="/new" target="_blank">New window</a>
<button>Delete project</button><input type="password" value="DO-NOT-CAPTURE"><textarea>SECRET-TEXT</textarea>
<section><textarea>CONTEXT-SECRET</textarea><span contenteditable>EDITABLE-SECRET</span><a href="/help">Help</a></section>
</body></html>`;

test('MV3 bridge → shared tabs → DOM → Jev selection → approved click, with fail-closed edges', { timeout: 120_000 }, async (t) => {
  const server = createServer((req, res) => {
    res.setHeader('Content-Type', 'text/html');
    res.end(req.url === '/deployments'
      ? '<!doctype html><title>Deployments</title><h1>Deployment logs</h1><a href="/">Dashboard</a>'
      : fixtureHTML);
  }).listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  const temp = await mkdtemp(join(tmpdir(), 'pi-browser-test-'));
  const extension = join(temp, 'chrome');
  await cp(resolve('chrome'), extension, { recursive: true });
  const manifest = JSON.parse(await readFile(join(extension, 'manifest.json'), 'utf8'));
  // Headless tests cannot press the browser toolbar to grant activeTab. Grant ONLY
  // fixture hosts in the temporary copy; the shipped manifest has no host access.
  manifest.host_permissions = ['http://127.0.0.1/*', 'http://localhost/*'];
  await writeFile(join(extension, 'manifest.json'), JSON.stringify(manifest));
  const bridge = new Bridge({ persistent: true, statePath: join(temp, 'credentials.json'), port: 0 });
  await bridge.start();
  // Keep the first ephemeral allocation stable for the simulated Pi restart.
  bridge.port = bridge.pairing.port;
  let context;
  t.after(async () => {
    await context?.close();
    await bridge.stop();
    await new Promise((resolve) => server.close(resolve));
    await rm(temp, { recursive: true, force: true });
  });
  context = await chromium.launchPersistentContext(join(temp, 'profile'), {
    channel: 'chromium', headless: true,
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
  });
  const worker = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker');
  const id = new URL(worker.url()).host;
  const target = await context.newPage();
  await target.goto(base);
  const popup = await context.newPage();
  await popup.goto(`chrome-extension://${id}/popup.html`);
  await popup.locator('#port').fill(String(bridge.pairing.port));
  await popup.locator('#token').fill(bridge.pairing.token);
  await popup.getByRole('button', { name: 'Pair with Pi' }).click();
  await popup.waitForFunction(() => document.getElementById('status').textContent.includes('Paired with Pi'), null, { timeout: 8000 })
    .catch(async (error) => { throw new Error(`${error.message}\nPopup: ${await popup.locator('#status').textContent()}`); });
  const tabId = await worker.evaluate(async (url) => (await chrome.tabs.query({})).find((tab) => tab.url === url + '/').id, base);
  const ui = (message) => popup.evaluate((m) => chrome.runtime.sendMessage(m), message);
  const share = async () => {
    const response = await ui({ type: 'share', tabId });
    assert.equal(response.error, undefined, JSON.stringify(response));
  };
  assert.deepEqual(await bridge.request('tabs'), []);
  await assert.rejects(bridge.request('read', { tabId }), /not shared/);
  await assert.rejects(bridge.request('query', { tabId, question: 'Checks?' }), /not shared/);
  await share();
  assert.equal((await bridge.request('tabs'))[0].tabId, tabId);
  assert.equal(await worker.evaluate((id) => chrome.action.getBadgeText({ tabId: id }), tabId), 'ON');

  // Targeted evidence can find content after the preview, without leaking inputs or a full page.
  await target.evaluate(() => {
    const section = document.createElement('section');
    section.id = 'query-fixture';
    section.innerHTML = `<p>${'Background information. '.repeat(1400)}</p>` +
      '<h2>Merge status</h2><p>All checks passed for head CURRENT123. No conflicts with base branch.</p>' +
      '<p hidden>HIDDEN-EVIDENCE-SECRET</p>';
    document.body.append(section);
  });
  const preview = await bridge.request('read', { tabId });
  assert.equal(preview.textTruncated, true);
  assert.doesNotMatch(preview.text, /CURRENT123/);
  const question = 'What is the merge status and current head checks?';
  const rawEvidence = await bridge.request('query', { tabId, question });
  assert.equal(rawEvidence.passages.length, 16);
  assert.ok(rawEvidence.nextCursor);
  assert.doesNotMatch(JSON.stringify(rawEvidence), /SECRET|DO-NOT-CAPTURE/);
  const seen = new Set(rawEvidence.passages.map((p) => p.id));
  let cursor = rawEvidence.nextCursor;
  while (cursor !== null) {
    const batch = await bridge.request('query', { tabId, question, cursor, snapshotId: rawEvidence.snapshotId });
    for (const p of batch.passages) { assert.equal(seen.has(p.id), false); seen.add(p.id); }
    cursor = batch.nextCursor;
  }
  assert.equal(seen.size, rawEvidence.totalPassages);
  await assert.rejects(bridge.request('query', { tabId, question: 'Different question',
    snapshotId: rawEvidence.snapshotId, cursor: rawEvidence.nextCursor }), /question changed/);
  const evidenceClient = { systemOne: async ({ state, questions }) => ({
    answers: questions.relation ? { relation: { type: 'choice', choice: 'supports', confidence: 0.99, probabilities: { supports: 0.99 } } } :
      questions.finding ? { finding: { type: 'choice', choice: 'f0', confidence: 0.99, probabilities: { f0: 0.99 } } } :
      Object.fromEntries(state.passages.map((p, i) => [`p${i}`, { type: 'noul', noul: p.text.includes('CURRENT123') ? 0.99 : 0.01 }])),
  }) };
  const evidenceBrowser = new Browser(bridge, () => evidenceClient);
  const queried = await evidenceBrowser.query(tabId, question, { claim: 'The page says checks passed for head CURRENT123.' });
  assert.equal(queried.data.status, 'supports');
  assert.equal(queried.data.evidence, undefined);
  assert.ok(JSON.stringify(queried.data).length < 500);
  assert.equal(queried.data.coverage, 'partial');
  const expanded = await evidenceBrowser.query(tabId, question, { claim: 'The page says checks passed for head CURRENT123.',
    snapshotId: queried.data.snapshotId, detail: 'evidence' });
  assert.match(expanded.data.evidence[0].text, /CURRENT123/);
  assert.equal(expanded.usage, undefined);
  t.diagnostic(`Query payload: compact ${JSON.stringify(queried.data).length} characters; opt-in evidence ${JSON.stringify(expanded.data).length} characters`);
  if (process.env.PI_BROWSER_LIVE === '1') {
    const liveEvidenceBrowser = new Browser(bridge, () => createJev());
    const liveQuery = await liveEvidenceBrowser.query(tabId, question, {
      claim: 'The page says all checks passed for head CURRENT123.',
    });
    assert.equal(liveQuery.data.status, 'supports');
    assert.ok(JSON.stringify(liveQuery.data).length < 500);
    const finding = await liveEvidenceBrowser.query(tabId, 'Which head has passed checks?');
    // Live judgments may abstain. Never lower gates just to force a short answer.
    assert.ok(['evidence', 'needs_evidence'].includes(finding.data.status));
    if (finding.data.status === 'evidence') {
      assert.match(finding.data.finding, /CURRENT123/);
      assert.ok(finding.data.finding.length <= 320);
    } else assert.equal(finding.data.finding, undefined);
    const findingEvidence = await liveEvidenceBrowser.query(tabId, 'Which head has passed checks?', {
      snapshotId: finding.data.snapshotId, cursor: finding.data.cursor, detail: 'evidence',
    });
    assert.ok(findingEvidence.data.evidence.some((p) => p.text.includes('CURRENT123')));
    assert.equal(findingEvidence.usage, undefined);
    const missing = await liveEvidenceBrowser.query(tabId, 'What are the results of the security scan for head UNKNOWN456?', {
      claim: 'The security scan passed for head UNKNOWN456.',
    });
    assert.ok(['not_established', 'uncertain'].includes(missing.data.status));
  }
  const staleEvidence = { snapshotId: queried.data.snapshotId, cursor: queried.data.nextCursor };
  await target.evaluate(() => document.querySelector('#query-fixture h2').textContent = 'Changed status');
  await assert.rejects(bridge.request('query', { tabId, question,
    claim: 'The page says checks passed for head CURRENT123.', ...staleEvidence }), /Stale evidence/);
  const mutatingBrowser = new Browser(bridge, () => ({ systemOne: async (request) => {
    const result = await evidenceClient.systemOne(request);
    await target.evaluate(() => document.querySelector('#query-fixture h2').textContent += ' changed');
    return result;
  } }));
  await assert.rejects(mutatingBrowser.query(tabId, question), /Stale evidence/);
  const navigatedEvidence = await bridge.request('query', { tabId, question });
  await target.evaluate(() => history.pushState({}, '', '/query-navigation'));
  await assert.rejects(bridge.request('query_validate', { tabId, snapshotId: navigatedEvidence.snapshotId }), /Stale evidence/);
  await target.evaluate(() => history.replaceState({}, '', '/'));
  await target.evaluate(() => document.getElementById('query-fixture').remove());
  await target.evaluate(() => {
    const section = document.createElement('section');
    section.id = 'query-limit';
    section.textContent = 'Budget test. '.repeat(10_000);
    document.body.append(section);
  });
  const boundedEvidence = await bridge.request('query', { tabId, question: 'Budget?' });
  assert.equal(boundedEvidence.textTruncated, true);
  assert.ok(boundedEvidence.totalPassages <= 120);
  assert.ok(boundedEvidence.passages.every((p) => p.text.length <= 1000));
  await target.evaluate(() => document.getElementById('query-limit').remove());

  const snapshot = await bridge.request('read', { tabId });
  assert.deepEqual(snapshot.links.map((l) => l.label), ['Settings', 'Deployments', 'Help']);
  assert.ok(snapshot.links.every((link) => !Object.hasOwn(link, 'context')));
  assert.doesNotMatch(JSON.stringify(snapshot), /DO-NOT-CAPTURE|SECRET-TEXT|CONTEXT-SECRET|EDITABLE-SECRET/);
  const candidates = await bridge.request('candidates', { tabId, goal: 'Open deployments' });
  assert.equal(candidates.candidates[0].id, 'e2');
  assert.equal(candidates.text, undefined);
  assert.ok(candidates.candidates.every((candidate) => Object.keys(candidate).sort().join(',') === 'href,id,label'));
  await assert.rejects(bridge.request('click', { tabId, snapshotId: snapshot.snapshotId, candidateId: 'e2' }), /unapproved/);
  await target.evaluate(() => document.querySelector('h1').textContent = 'Changed while deciding');
  await assert.rejects(bridge.request('click', {
    tabId, snapshotId: snapshot.snapshotId, candidateId: 'e2', approved: true,
  }), /Stale/);

  const replacing = await bridge.request('read', { tabId });
  await target.evaluate(() => {
    const link = document.querySelector('a[href="/deployments"]');
    link.replaceWith(link.cloneNode(true));
  });
  await assert.rejects(bridge.request('click', {
    tabId, snapshotId: replacing.snapshotId, candidateId: 'e2', approved: true,
  }), /Stale/);

  await target.evaluate(() => {
    const overlay = document.createElement('div');
    overlay.id = 'overlay';
    overlay.style.cssText = 'position:fixed;inset:0;z-index:99999;background:white';
    document.body.append(overlay);
  });
  const obstructed = await bridge.request('read', { tabId });
  await assert.rejects(bridge.request('click', {
    tabId, snapshotId: obstructed.snapshotId, candidateId: 'e2', approved: true,
  }), /obstructed/);
  await target.evaluate(() => document.getElementById('overlay').remove());

  const changedURL = await bridge.request('read', { tabId });
  await target.evaluate(() => history.pushState({}, '', '/same-document-change'));
  await assert.rejects(bridge.request('click', {
    tabId, snapshotId: changedURL.snapshotId, candidateId: 'e2', approved: true,
  }), /Stale/);
  await target.evaluate(() => history.replaceState({}, '', '/'));

  const stale = await bridge.request('read', { tabId });
  const revokedEvidence = await bridge.request('query', { tabId, question: 'Deployments?' });
  await ui({ type: 'revoke', tabId });
  await assert.rejects(bridge.request('query_validate', { tabId, snapshotId: revokedEvidence.snapshotId }), /not shared/);
  await assert.rejects(bridge.request('click', {
    tabId, snapshotId: stale.snapshotId, candidateId: 'e2', approved: true,
  }), /not shared/);
  await share();
  await assert.rejects(bridge.request('query_validate', { tabId, snapshotId: revokedEvidence.snapshotId }), /Stale evidence/);
  const client = process.env.PI_BROWSER_LIVE === '1' ? createJev() : {
    systemOne: async ({ questions }) => {
      const choice = Object.hasOwn(questions.target.criteria, `t${tabId}`) ? `t${tabId}` : 'e2';
      return { model: 'fixture', answers: { target: {
        type: 'choice', choice, confidence: 0.99, probabilities: { [choice]: 0.99 },
      } } };
    },
  };
  const browser = new Browser(bridge, () => client);
  const found = await browser.findTab('Find the project dashboard');
  assert.equal(found.status, 'selected');
  assert.equal(found.candidate.tabId, tabId);
  const navigated = await browser.followLink(tabId, 'Open the project deployments to inspect deployment logs', {
    confirm: async ({ href }) => { assert.equal(href, `${base}/deployments`); return true; },
  });
  assert.equal(navigated.status, 'clicked');
  assert.match(navigated.result.page.text, /Deployment logs/);
  assert.equal(target.url(), `${base}/deployments`);

  // Mutation during approval is revalidated by the content script after approval.
  await target.goto(base);
  await assert.rejects(browser.followLink(tabId, 'Open deployments', {
    confirm: async () => {
      await target.evaluate(() => document.querySelector('a[href="/deployments"]').href = '/settings');
      return true;
    },
  }), /Stale|changed/);
  assert.equal(target.url(), `${base}/`);

  // Cross-origin navigation revokes access rather than inheriting a tab ID grant.
  await target.goto(base.replace('127.0.0.1', 'localhost'));
  await assert.rejects(bridge.request('read', { tabId }), /not shared|origin/);
  assert.deepEqual(await bridge.request('tabs'), []);
  await target.goto(base);
  await ui({ type: 'policy_add', origin: base, actions: ['read', 'navigate', 'click'] });
  const policyTabs = await bridge.request('tabs');
  assert.equal(policyTabs[0].tabId, tabId);
  const automatic = await browser.followLink(tabId, 'Open deployments automatically');
  assert.equal(automatic.status, 'clicked');
  await target.goto(base);
  await bridge.stop();
  await bridge.start();
  let reconnected;
  for (let attempt = 0; attempt < 32; attempt++) {
    reconnected = await ui({ type: 'status' });
    if (reconnected.result.connected) break;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  assert.equal(reconnected.result.connected, true);
  assert.equal((await bridge.request('tabs'))[0].tabId, tabId);
  await popup.getByRole('button', { name: 'Disconnect & stop all' }).click();
  await popup.waitForFunction(() => document.getElementById('status').textContent.includes('Not paired'));
  assert.equal(await worker.evaluate((id) => chrome.action.getBadgeText({ tabId: id }), tabId), '');
  await assert.rejects(async () => bridge.request('read', { tabId }, { timeout: 100 }), /disconnected/);
  assert.equal(await worker.evaluate(() => chrome.alarms.get('pi-browser-reconnect')), undefined);

  // Unexpected worker termination must not restore grants from storage.session.
  await ui({ type: 'pair', ...bridge.pairing });
  await share();
  const cdp = await context.newCDPSession(target);
  const version = new Promise((resolve) => cdp.on('ServiceWorker.workerVersionUpdated', ({ versions }) => {
    const match = versions.find((v) => v.scriptURL === worker.url() && v.runningStatus === 'running');
    if (match) resolve(match.versionId);
  }));
  await cdp.send('ServiceWorker.enable');
  const versionId = await version;
  // Accelerate the real alarm in this unpacked fixture. No popup/API call may wake the worker.
  await worker.evaluate(() => chrome.alarms.create('pi-browser-reconnect', { when: Date.now() + 1500, periodInMinutes: 1 }));
  await popup.close();
  const disconnected = once(bridge.peer, 'close');
  await cdp.send('ServiceWorker.stopWorker', { versionId });
  await disconnected;
  const awaitConnection = async () => {
    const until = Date.now() + 12_000;
    while (!bridge.peer && Date.now() < until) await new Promise((resolve) => setTimeout(resolve, 100));
    assert.ok(bridge.peer, 'Saved pairing must reconnect without opening a popup or entering credentials');
  };
  await awaitConnection();
  await cdp.detach();
  const checkPopup = await context.newPage();
  await checkPopup.goto(`chrome-extension://${id}/popup.html`);
  const restarted = await checkPopup.evaluate(() => chrome.runtime.sendMessage({ type: 'status' }));
  assert.deepEqual(restarted.result, { connected: true, paired: true, shares: [], policies: [{
    origin: new URL(base).origin, actions: ['click', 'navigate', 'read'],
  }] });
  assert.equal(await checkPopup.locator('#pairing').isVisible(), false);
  assert.equal((await bridge.request('tabs'))[0].tabId, tabId);

  // Restart the entire browser using the same profile, not just Pi's socket.
  const browserClosed = once(bridge.peer, 'close');
  await context.close();
  await browserClosed;
  context = await chromium.launchPersistentContext(join(temp, 'profile'), {
    channel: 'chromium', headless: true,
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
  });
  await awaitConnection();
  const newWorker = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker');
  assert.ok(await newWorker.evaluate(() => chrome.alarms.get('pi-browser-reconnect')));
  assert.ok(await newWorker.evaluate(() => chrome.storage.local.get('pairing').then((s) => Boolean(s.pairing))));

  // Explicit Pi revoke removes durable pairing and the wakeup alarm; restart must not reconnect.
  await bridge.stop({ revoke: true });
  assert.equal(await newWorker.evaluate(() => chrome.storage.local.get('pairing').then((s) => s.pairing)), undefined);
  assert.equal(await newWorker.evaluate(() => chrome.alarms.get('pi-browser-reconnect')), undefined);
  await bridge.start();
  await new Promise((resolve) => setTimeout(resolve, 1500));
  assert.equal(bridge.peer, null);
});
