import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MAX_SELECTION_CANDIDATES, rankCandidates, selectCandidate, thresholds } from '../src/selection.ts';

const candidates = [{ id: 'e1', label: 'Settings' }, { id: 'e2', label: 'Deployments' }];
const response = (choice = 'e2', confidence = 0.95, probability = 0.98) => ({
  model: 'jev-test', usage: { input_tokens: 10, output_tokens: 5 },
  answers: { target: { type: 'choice', choice, confidence, probabilities: { [choice]: probability } } },
});
const select = (answer, extra = {}) => selectCandidate({
  client: { systemOne: async () => answer }, goal: 'Open deployment logs', kind: 'link', candidates, ...extra,
});

test('selects only supplied candidates, with a none option and untrusted-data instructions', async () => {
  let request;
  const result = await selectCandidate({
    client: { systemOne: async (r) => { request = r; return response(); } },
    goal: 'Open deployment logs', kind: 'link', candidates,
  });
  assert.equal(result.candidate.id, 'e2');
  assert.equal(result.status, 'selected');
  assert.equal(result.answer, undefined);
  assert.equal(result.model, undefined);
  assert.deepEqual(Object.keys(request.questions.target.criteria), ['e1', 'e2', 'none']);
  assert.match(request.questions.target.instructions, /untrusted evidence/);
  assert.equal(request.state.goal, 'Open deployment logs');
});
test('no-match and uncertainty never become selections', async () => {
  assert.equal((await select(response('none'))).status, 'no_match');
  assert.equal((await select(response('e2', 0.3))).status, 'uncertain');
  assert.equal((await select(response('e2', 0.95, 0.5))).status, 'uncertain');
  assert.equal((await select(null, { candidates: [] })).status, 'no_match');
});
test('rejects invented IDs, malformed responses, duplicate IDs and oversized candidate sets', async () => {
  await assert.rejects(select(response('invented')), /Invalid Jev/);
  await assert.rejects(select(response('e2', NaN)), /Invalid Jev/);
  await assert.rejects(select({ answers: {} }), /Invalid Jev/);
  await assert.rejects(select(response(), { candidates: [candidates[0], candidates[0]] }), /Invalid candidate/);
  await assert.rejects(select(response(), { candidates: Array(255).fill(candidates[0]) }), /Too many/);
});
test('large pages are narrowed by deterministic lexical ranking before Jev sees them', async () => {
  const many = Array.from({ length: 100 }, (_, index) => ({ id: `e${index}`, label: `Article ${index}`, href: `/article-${index}` }));
  many[90] = { id: 'e90', label: 'Football Gossip', href: '/football-gossip' };
  let request;
  const result = await selectCandidate({
    client: { systemOne: async (value) => { request = value; return response('e90'); } },
    goal: 'Open today\'s football gossip', kind: 'link', candidates: many,
  });
  assert.equal(MAX_SELECTION_CANDIDATES, 48);
  assert.equal(rankCandidates('Open today\'s football gossip', many)[0].id, 'e90');
  assert.equal(request.state.candidates.length, MAX_SELECTION_CANDIDATES);
  assert.ok(request.state.candidates.some((candidate) => candidate.id === 'e90'));
  assert.equal(result.candidate.id, 'e90');
});

test('thresholds are validated and caller cancellation propagates', async () => {
  assert.deepEqual(thresholds({}), { confidence: 0.7, probability: 0.8 });
  assert.throws(() => thresholds({ PI_BROWSER_MIN_CONFIDENCE: 'bad' }), /between/);
  assert.throws(() => thresholds({ PI_BROWSER_MIN_PROBABILITY: '-1' }), /between/);
  const signal = AbortSignal.abort();
  await assert.rejects(select(response(), { signal }), { name: 'AbortError' });
});
