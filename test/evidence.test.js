import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compactEvidence, queryEvidence } from '../src/evidence.ts';
import { Browser } from '../src/browser.ts';

const page = { snapshotId: 'q1', url: 'https://example.com/pr/105', title: 'PR 105', observedAt: Date.now(),
  cursor: 0, nextCursor: null, totalPassages: 2, textTruncated: false,
  passages: [{ id: 'p0', start: 0, text: 'Checks (25). Author says all checks passed at old revision abc.' },
    { id: 'p840', start: 840, text: 'Current head def. CI pending. An old review covered abc.' }] };
function client(probabilities = [0.99, 0.99], relation = 'not_established', confidence = 0.99) {
  const calls = [];
  return { calls, systemOne: async (request, options) => {
    calls.push(request);
    options.signal.throwIfAborted();
    const answers = request.questions.relation ? { relation: {
      type: 'choice', choice: relation, confidence, probabilities: { [relation]: 0.99 },
    } } : request.questions.finding ? { finding: {
      type: 'choice', choice: 'f0', confidence, probabilities: { f0: 0.99 },
    } } : Object.fromEntries(Object.keys(request.questions).map((key, i) => [key, { type: 'noul', noul: probabilities[i] }]));
    return { answers, usage: { input_tokens: 50, output_tokens: 5 }, model: 'fixture' };
  } };
}

test('query returns exact excerpts and scoped claim judgment, not model maps or page dump', async () => {
  const jev = client();
  const result = await queryEvidence({ client: jev, page, question: 'What is the current CI status?',
    claim: 'All checks have passed for the current head.' });
  assert.equal(result.data.status, 'evidence');
  assert.deepEqual(result.data.evidence.map((p) => p.text), page.passages.map((p) => p.text));
  assert.equal(result.data.verification.status, 'not_established');
  assert.equal(result.data.verification.scope, 'returned_excerpts_only');
  assert.equal(result.data.coverage.complete, true);
  assert.equal(result.usage.input, 100);
  assert.equal(result.usage.output, 10);
  assert.doesNotMatch(JSON.stringify(result.data), /"probabilities"|"answers"|"usage"|"model"/);
  assert.match(jev.calls[1].questions.relation.instructions, /count alone|old review/);
  assert.match(jev.calls[0].questions.p0.instructions, /untrusted evidence/);
});

test('uncertainty, no-match and omitted evidence never imply absence', async () => {
  for (const [probabilities, status] of [[[0.1, 0.1], 'no_match_in_batch'], [[0.6, 0.4], 'uncertain']]) {
    const jev = client(probabilities);
    const result = await queryEvidence({ client: jev, page: { ...page, nextCursor: 2, totalPassages: 5, textTruncated: true },
      question: 'Is it ready?', claim: 'Ready to merge' });
    assert.equal(result.data.status, status);
    assert.equal(result.data.verification.status, 'not_established');
    assert.equal(jev.calls.length, 1);
    assert.equal(result.data.coverage.complete, false);
    assert.deepEqual(result.data.continuation, { snapshotId: 'q1', cursor: 2 });
  }
  const many = { ...page, totalPassages: 4, passages: Array.from({ length: 4 }, (_, i) => ({ id: `p${i}`, start: i,
    text: 'CI passed', extra: 'PRIVATE-FIELD-DO-NOT-ECHO' })) };
  const result = await queryEvidence({ client: client([1, 1, 1, 1]), page: many, question: 'CI?' });
  assert.equal(result.data.evidence.length, 3);
  assert.equal(result.data.coverage.outputTruncated, true);
  assert.equal(result.data.coverage.complete, false);
  assert.doesNotMatch(JSON.stringify(result.data), /PRIVATE-FIELD|extra/);
});

test('verification gates, malformed judgments and invented labels fail closed', async () => {
  const result = await queryEvidence({ client: client([1, 1], 'supports', 0.4), page, question: 'CI?', claim: 'CI passed' });
  assert.equal(result.data.verification.status, 'uncertain');
  for (const bad of [NaN, 2, undefined]) {
    await assert.rejects(queryEvidence({ client: client([bad, 1]), page, question: 'CI?' }), /Invalid Jev/);
  }
  await assert.rejects(queryEvidence({ client: client([1, 1], 'invented'), page, question: 'CI?', claim: 'CI passed' }), /verification/);
  await assert.rejects(queryEvidence({ client: client(), page: { ...page, nextCursor: 99 }, question: 'CI?' }), /continuation/);
  await assert.rejects(queryEvidence({ client: client(), page: { ...page, passages: [page.passages[0], page.passages[0]] }, question: 'CI?' }), /evidence response/);
  await assert.rejects(queryEvidence({ client: client(), page: { ...page, passages: [{ ...page.passages[0], text: 'x'.repeat(1001) }] }, question: 'CI?' }), /evidence response/);
});

test('cancellation during inference prevents publication even if the client returns answers', async () => {
  const controller = new AbortController();
  const calls = [];
  const browser = new Browser({ request: async (op) => { calls.push(op); return page; } }, () => ({
    systemOne: async (request, options) => {
      const result = await client().systemOne(request, options);
      controller.abort();
      return result;
    },
  }));
  await assert.rejects(browser.query(1, 'CI?', { claim: 'CI passed', signal: controller.signal }), { name: 'AbortError' });
  assert.deepEqual(calls, ['query']);
});

test('query validates freshness after inference and never navigates or retries stale reads', async () => {
  const calls = [];
  let stale = false;
  const bridge = { request: async (op, args) => {
    calls.push({ op, args });
    if (op === 'query') return page;
    if (stale) throw new Error('Stale evidence');
    return { snapshotId: page.snapshotId };
  } };
  const browser = new Browser(bridge, () => client());
  const result = await browser.query(1, 'CI?');
  assert.equal(result.data.snapshotId, page.snapshotId);
  assert.deepEqual(calls.map((c) => c.op), ['query', 'query_validate']);
  stale = true;
  await assert.rejects(browser.query(1, 'CI?'), /Stale evidence/);
  assert.deepEqual(calls.map((c) => c.op), ['query', 'query_validate', 'query', 'query_validate']);
  await assert.rejects(browser.query(1, 'CI?', { cursor: 3 }), /continuation/);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(browser.query(1, 'CI?', { signal: controller.signal }), { name: 'AbortError' });
  assert.equal(calls.length, 4);
});

test('compact defaults keep evidence internal, expand cached evidence only on explicit request', async () => {
  const calls = [];
  let revoked = false;
  const jev = client();
  const browser = new Browser({ request: async (op) => {
    calls.push(op);
    if (revoked) throw new Error('Tab sharing revoked');
    return op === 'query' ? page : { snapshotId: page.snapshotId };
  } }, () => jev);
  const { data } = await browser.query(1, 'CI?', { claim: 'Ready?' });
  assert.equal(data.status, 'not_established');
  assert.equal(data.coverage, 'captured_dom');
  assert.ok(JSON.stringify(data).length < 400);
  assert.doesNotMatch(JSON.stringify(data), /Checks \(25\)|CI pending|limitation|observedAt|title|probabilities|verification/);
  assert.deepEqual(data.evidenceIds, ['p0', 'p840']);
  const expanded = await browser.query(1, 'CI?', { claim: 'Ready?', snapshotId: data.snapshotId, detail: 'evidence' });
  assert.deepEqual(expanded.data.evidence.map((p) => p.text), page.passages.map((p) => p.text));
  assert.equal(expanded.usage, undefined, 'cache hits must not count inference twice');
  assert.equal(jev.calls.length, 2);
  assert.deepEqual(calls, ['query', 'query_validate', 'query_validate']);
  revoked = true;
  await assert.rejects(browser.query(1, 'CI?', { claim: 'Ready?', snapshotId: data.snapshotId, detail: 'evidence' }), /revoked/);
  await assert.rejects(browser.query(1, 'CI?', { detail: 'everything' }), /detail/);
});

test('open questions get a short exact finding; uncertain/invented choices never become facts', async () => {
  const result = await queryEvidence({ client: client(), page, question: 'CI?' });
  const compact = compactEvidence(result.data);
  assert.equal(compact.findingType, 'source_excerpt');
  assert.ok(page.passages.some((p) => p.text.includes(compact.finding)));
  assert.ok(compact.finding.length <= 320);
  const uncertain = await queryEvidence({ client: client([1, 1], 'not_established', 0.4), page, question: 'CI?' });
  assert.equal(compactEvidence(uncertain.data).status, 'needs_evidence');
  assert.equal(compactEvidence(uncertain.data).finding, undefined);
  const bad = { systemOne: async (request, options) => request.questions.finding
    ? { answers: { finding: { type: 'choice', choice: 'invented', confidence: 1, probabilities: { invented: 1 } } } }
    : client().systemOne(request, options) };
  await assert.rejects(queryEvidence({ client: bad, page, question: 'CI?' }), /finding response/);
  const long = { ...page, totalPassages: 1, passages: [{ id: 'p0', start: 0, text: 'a'.repeat(900) + ' is NOT successful.' }] };
  const omitted = await queryEvidence({ client: client([1]), page: long, question: 'Successful?' });
  assert.equal(compactEvidence(omitted.data).status, 'needs_evidence', 'never cut off a qualification to meet the budget');
});
