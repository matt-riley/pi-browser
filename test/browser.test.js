import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Browser } from '../src/browser.ts';

const page = { snapshotId: 's1', url: 'https://example.com/', title: 'Example', text: 'Welcome',
  links: [{ id: 'e1', label: 'Deployments', href: 'https://example.com/deployments' }] };
function fixture(answer = 'e1') {
  const calls = [];
  const bridge = { request: async (op, args) => {
    calls.push({ op, args });
    if (op === 'tabs') return [{ tabId: 1, title: 'Example', url: page.url }];
    if (op === 'read') return page;
    if (op === 'candidates') return { snapshotId: page.snapshotId, url: page.url, title: page.title, candidates: page.links };
    return { action: 'clicked', page: { snapshotId: 's2', url: page.links[0].href, title: 'Deployments', text: 'Deployment logs', textTruncated: false } };
  } };
  const client = { systemOne: async () => ({ answers: { target: {
    type: 'choice', choice: answer, confidence: 0.99, probabilities: { [answer]: 0.99 },
  } } }) };
  return { browser: new Browser(bridge, () => client), calls, bridge };
}

test('requires approval and then clicks the exact snapshot candidate once', async () => {
  const { browser, calls } = fixture();
  const result = await browser.followLink(1, 'Open deployments', { confirm: async (target) => {
    assert.equal(target.href, page.links[0].href);
    assert.equal(calls.length, 1);
    return true;
  } });
  assert.equal(result.status, 'clicked');
  assert.equal(result.effect, 'confirmed');
  assert.equal(result.hint, 'read again');
  assert.equal(result.result.page.url, page.links[0].href);
  assert.equal(result.result.page.title, 'Deployments');
  assert.deepEqual(calls[1], { op: 'click', args: { tabId: 1, snapshotId: 's1', candidateId: 'e1', approved: true } });
});
test('reports suspected_noop when the URL and title did not change', async () => {
  const { browser, bridge } = fixture();
  const request = bridge.request;
  bridge.request = async (op, args) => {
    const value = await request(op, args);
    if (op === 'click') {
      return { action: 'clicked', page: { snapshotId: 's2', url: page.url, title: page.title, text: 'Welcome', textTruncated: false } };
    }
    return value;
  };
  const result = await browser.followLink(1, 'Open deployments', { confirm: async () => true });
  assert.equal(result.status, 'clicked');
  assert.equal(result.effect, 'suspected_noop');
  assert.equal(result.hint, 'read again');
});
test('reports unverifiable when the click cannot be observed, without throwing', async () => {
  const { browser, bridge } = fixture();
  const request = bridge.request;
  bridge.request = async (op, args) => {
    const value = await request(op, args);
    if (op === 'click') return { action: 'clicked', observationError: 'Page still loading; read it again later' };
    return value;
  };
  const result = await browser.followLink(1, 'Open deployments', { confirm: async () => true });
  assert.equal(result.status, 'clicked');
  assert.equal(result.effect, 'unverifiable');
  assert.equal(result.hint, 'read again');
  assert.equal(result.result.observationError, 'Page still loading; read it again later');
  assert.equal(result.result.page, undefined);
});
test('reports refused with a needs-approval hint when the user denies the click', async () => {
  const { browser, calls } = fixture();
  const result = await browser.followLink(1, 'Open deployments', { confirm: async () => false });
  assert.equal(result.status, 'denied');
  assert.equal(result.effect, 'refused');
  assert.equal(result.hint, 'needs approval');
  assert.equal(calls.filter((c) => c.op === 'click').length, 0);
});
test('confirms a title-only change and stays unverifiable when truncated text cannot prove a no-op', async () => {
  const { browser, bridge } = fixture();
  const request = bridge.request;
  bridge.request = async (op, args) => {
    const value = await request(op, args);
    if (op === 'candidates') return { ...value, text: 'Welcome', textTruncated: false };
    if (op === 'click') {
      return { action: 'clicked', page: { snapshotId: 's2', url: page.url, title: 'Updated', text: 'Welcome', textTruncated: false } };
    }
    return value;
  };
  const titled = await browser.followLink(1, 'Open deployments', { confirm: async () => true });
  assert.equal(titled.effect, 'confirmed');
  assert.equal(titled.hint, 'read again');

  bridge.request = async (op, args) => {
    const value = await request(op, args);
    if (op === 'candidates') return { ...value, text: 'Welcome', textTruncated: true };
    if (op === 'click') {
      return { action: 'clicked', page: { snapshotId: 's2', url: page.url, title: page.title, text: 'Welcome', textTruncated: true } };
    }
    return value;
  };
  const truncated = await browser.followLink(1, 'Open deployments', { confirm: async () => true });
  assert.equal(truncated.effect, 'unverifiable');
  assert.equal(truncated.hint, 'read again');
});
test('every click asks, even if the browser says a site allows clicks without asking', async () => {
  const { browser, bridge, calls } = fixture();
  const request = bridge.request;
  bridge.request = async (op, args) => ({ ...await request(op, args), ...(op === 'candidates' ? { canAutoApproveClick: true } : {}) });
  let asked = 0;
  assert.equal((await browser.followLink(1, 'Open deployments', { confirm: async () => { asked++; return false; } })).status, 'denied');
  assert.equal(asked, 1);
  assert.equal(calls.filter((c) => c.op === 'click').length, 0);
});
test('denied, absent UI, no-match and cancellation never click', async () => {
  for (const confirm of [async () => false, undefined]) {
    const { browser, calls } = fixture();
    if (confirm) {
      assert.equal((await browser.followLink(1, 'Open deployments', { confirm })).status, 'denied');
      assert.equal(calls.filter((c) => c.op === 'click').length, 0);
    } else {
      // Without a UI to ask, fail at once: no page read, no Jev call, no click.
      await assert.rejects(browser.followLink(1, 'Open deployments'), /can't ask you to approve clicks/);
      assert.deepEqual(calls, []);
    }
  }
  const { browser, calls } = fixture('none');
  assert.equal((await browser.followLink(1, 'Open deployments', { confirm: async () => true })).status, 'no_match');
  assert.equal(calls.length, 1);
  const other = fixture();
  const controller = new AbortController();
  await assert.rejects(other.browser.followLink(1, 'Open deployments', {
    signal: controller.signal, confirm: async () => { controller.abort(); return true; },
  }), { name: 'AbortError' });
  assert.equal(other.calls.length, 1);
});
test('serializes concurrent operations on one tab, including approval wait', async () => {
  const { browser, calls } = fixture();
  let release;
  const approved = new Promise((resolve) => { release = resolve; });
  const action = browser.followLink(1, 'Open deployments', { confirm: () => approved });
  const read = browser.read(1);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(calls.map((c) => c.op), ['candidates']);
  release(true);
  await Promise.all([action, read]);
  assert.deepEqual(calls.map((c) => c.op), ['candidates', 'click', 'read']);
  assert.equal(browser.queues.size, 0);
});
test('never retries failed mutations; validates browser responses and refuses truncation', async () => {
  const { browser, bridge, calls } = fixture();
  const request = bridge.request;
  bridge.request = async (op, args) => {
    const value = await request(op, args);
    if (op === 'click') throw new Error('Stale snapshot');
    return value;
  };
  await assert.rejects(browser.followLink(1, 'Open deployments', { confirm: async () => true }), /Stale/);
  assert.equal(calls.filter((c) => c.op === 'click').length, 1);
  bridge.request = async () => ({ ...page, candidates: Array(49).fill(page.links[0]) });
  await assert.rejects(browser.followLink(1, 'Open deployments', { confirm: async () => true }), /candidate/);
  bridge.request = async () => ({ text: '' });
  await assert.rejects(browser.read(1), /Invalid DOM/);
});
test('finds tabs through the same Jev selection boundary', async () => {
  const { browser } = fixture('t1');
  const result = await browser.findTab('Example');
  assert.equal(result.candidate.tabId, 1);
});

test('read halves the model-facing page budget and flags the truncation', async () => {
  const { browser, bridge } = fixture();
  const long = { ...page, text: 'x'.repeat(4_000) };
  bridge.request = async (op) => (op === 'read' ? long : {});
  const read = await browser.read(1);
  assert.equal(read.text.length, 2_000);
  assert.equal(read.textTruncated, true);
  assert.deepEqual(read.links, page.links.map(({ id, label, href }) => ({ id, label, href })));
});

test('model-facing tab overview is bounded while Jev still sees every tab', async () => {
  const { browser, bridge } = fixture();
  const many = Array.from({ length: 60 }, (_, i) => ({ tabId: i + 1,
    title: `Tab ${i} ${'x'.repeat(280)}`, url: `https://example.com/p/${i}?q=${'y'.repeat(1200)}` }));
  bridge.request = async (op) => (op === 'tabs' ? many : []);
  const overview = await browser.tabOverview(undefined);
  const budget = JSON.stringify(overview).length;
  assert.ok(budget <= 4_300, `overview cost ${budget} characters`);
  assert.ok(overview.more > 0);
  assert.ok(overview.tabs.every((t) => t.title.length <= 120));
  const selected = await browser.tabs(undefined);
  assert.equal(selected.length, 60, 'Jev selection must still consider every tab, not the bounded overview');
});
