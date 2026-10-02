import { selectCandidate } from './selection.ts';
import { compactEvidence, queryEvidence, validateEvidencePage } from './evidence.ts';

// Chrome still captures 4,000 for internal use; the model gets half that and a truncation flag.
// browser_query is the tool for content, so a read only has to orient.
const PUBLIC_TEXT_LIMIT = 2_000;
const PUBLIC_LINK_LIMIT = 12;
const TAB_LIST_BUDGET = 4_000;

export function compactPage(page, { textLimit = PUBLIC_TEXT_LIMIT, linkLimit = PUBLIC_LINK_LIMIT } = {}) {
  const text = typeof page.text === 'string' ? page.text.slice(0, textLimit) : '';
  const sourceLinks = Array.isArray(page.links) ? page.links : [];
  return {
    snapshotId: page.snapshotId,
    url: page.url,
    title: page.title,
    text,
    textTruncated: Boolean(page.textTruncated) || text.length < (page.text?.length ?? 0),
    links: sourceLinks.slice(0, linkLimit).map(({ id, label, href }) => ({ id, label, href })),
    linksTruncated: Boolean(page.linksTruncated) || sourceLinks.length > linkLimit,
  };
}

function validateSummary(page) {
  if (typeof page?.snapshotId !== 'string' || typeof page.url !== 'string' ||
      typeof page.title !== 'string' || typeof page.text !== 'string') {
    throw new Error('Invalid browser page summary');
  }
  return page;
}

export class Browser {
  queues = new Map();
  evidenceCache = new Map();

  constructor(bridge, getJev) {
    this.bridge = bridge;
    this.getJev = getJev;
  }

  async serial(tabId, signal, work) {
    const previous = this.queues.get(tabId) ?? Promise.resolve();
    const next = previous.catch(() => {}).then(() => {
      signal?.throwIfAborted();
      return work();
    });
    this.queues.set(tabId, next);
    try { return await next; } finally {
      if (this.queues.get(tabId) === next) this.queues.delete(tabId);
    }
  }

  async tabs(signal) {
    const tabs = await this.bridge.request('tabs', {}, { signal });
    if (!Array.isArray(tabs) || tabs.length > 254 || tabs.some((t) =>
      !Number.isSafeInteger(t.tabId) || typeof t.title !== 'string' || typeof t.url !== 'string')) {
      throw new Error('Invalid approved-tab response');
    }
    return tabs;
  }

  // Orientation only: the full list feeds Jev, the model gets a page-sized summary.
  async tabOverview(signal, budget = TAB_LIST_BUDGET) {
    const tabs = await this.tabs(signal);
    const shown = [];
    let used = 0;
    for (const { tabId, title, url } of tabs) {
      const entry = { tabId, title: title.slice(0, 120), url };
      const size = JSON.stringify(entry).length;
      if (shown.length && used + size > budget) break;
      used += size;
      shown.push(entry);
    }
    return { tabs: shown, more: tabs.length - shown.length };
  }

  async findTab(goal, signal) {
    const tabs = await this.tabs(signal);
    return selectCandidate({ client: this.getJev(), goal, kind: 'tab', signal,
      candidates: tabs.map((t) => ({ ...t, id: `t${t.tabId}` })) });
  }

  async open(url, signal) {
    const result = await this.bridge.request('open', { url }, { signal });
    if (!Number.isSafeInteger(result?.tabId) || typeof result.url !== 'string') {
      throw new Error('Invalid browser open response');
    }
    return result;
  }

  read(tabId, signal) {
    return this.serial(tabId, signal, async () => compactPage(await this.snapshot(tabId, signal)));
  }

  query(tabId, question, { claim, cursor = 0, snapshotId, detail = 'compact', signal } = {}) {
    return this.serial(tabId, signal, async () => {
      if (typeof question !== 'string' || !question.trim() || question.length > 2000 ||
          (claim !== undefined && (typeof claim !== 'string' || !claim.trim() || claim.length > 2000)) ||
          (cursor !== undefined && (!Number.isInteger(cursor) || cursor < 0)) ||
          (snapshotId !== undefined && typeof snapshotId !== 'string') ||
          (cursor > 0 && !snapshotId) || !['compact', 'evidence'].includes(detail)) {
        throw new Error('Invalid browser question, detail or continuation');
      }
      for (const [key, entry] of this.evidenceCache) {
        if (Date.now() - entry.data.source.observedAt > 120_000) this.evidenceCache.delete(key);
      }
      const cacheKey = JSON.stringify([tabId, snapshotId, cursor, question, claim]);
      const cached = this.evidenceCache.get(cacheKey);
      if (snapshotId && cached) {
        await this.validateEvidence(tabId, snapshotId, signal);
        return { data: detail === 'evidence' ? cached.data : compactEvidence(cached.data) };
      }
      const page = validateEvidencePage(await this.bridge.request('query', {
        tabId, question, claim, cursor, snapshotId,
      }, { signal }));
      if (page.cursor !== (cursor ?? 0) || (snapshotId !== undefined && page.snapshotId !== snapshotId)) {
        throw new Error('Evidence continuation mismatch');
      }
      const result = await queryEvidence({ client: this.getJev(), page, question, claim, signal });
      signal?.throwIfAborted();
      // The tab, grant, URL and DOM must still match after inference. No stale citations.
      await this.validateEvidence(tabId, page.snapshotId, signal);
      const key = JSON.stringify([tabId, page.snapshotId, cursor, question, claim]);
      this.evidenceCache.set(key, { data: result.data });
      if (this.evidenceCache.size > 32) this.evidenceCache.delete(this.evidenceCache.keys().next().value);
      return { data: detail === 'evidence' ? result.data : compactEvidence(result.data), usage: result.usage };
    });
  }

  async validateEvidence(tabId, snapshotId, signal) {
    const current = await this.bridge.request('query_validate', { tabId, snapshotId }, { signal });
    signal?.throwIfAborted();
    if (current?.snapshotId !== snapshotId) throw new Error('Stale evidence; query the page again');
  }

  async snapshot(tabId, signal) {
    const page = await this.bridge.request('read', { tabId }, { signal });
    if (typeof page?.snapshotId !== 'string' || typeof page.url !== 'string' ||
        typeof page.title !== 'string' || typeof page.text !== 'string' || !Array.isArray(page.links) ||
        page.links.length > 254 || page.links.some((l) =>
          typeof l.id !== 'string' || typeof l.label !== 'string' || typeof l.href !== 'string')) {
      throw new Error('Invalid DOM snapshot');
    }
    return page;
  }

  async candidates(tabId, goal, signal) {
    const page = await this.bridge.request('candidates', { tabId, goal }, { signal });
    if (typeof page?.snapshotId !== 'string' || typeof page.url !== 'string' ||
        typeof page.title !== 'string' || !Array.isArray(page.candidates) || page.candidates.length > 48 ||
        page.candidates.some((l) => typeof l.id !== 'string' || typeof l.label !== 'string' || typeof l.href !== 'string')) {
      throw new Error('Invalid browser candidate response');
    }
    return page;
  }

  followLink(tabId, goal, { signal, confirm } = {}) {
    return this.serial(tabId, signal, async () => {
      // The extension ranks links locally and sends only a small candidate set to Pi.
      const page = await this.candidates(tabId, goal, signal);
      const decision = await selectCandidate({
        client: this.getJev(), goal, candidates: page.candidates,
        context: { url: page.url, title: page.title }, kind: 'link', signal,
      });
      if (decision.status !== 'selected') return decision;
      const target = decision.candidate;
      const autoApproved = page.canAutoApproveClick === true;
      if (!autoApproved) {
        if (!confirm) throw new Error('Click requires an interactive approval; no action taken');
        signal?.throwIfAborted();
        const approved = await confirm({ tabId, url: page.url, label: target.label, href: target.href });
        signal?.throwIfAborted();
        if (!approved) return { ...decision, status: 'denied' };
      }
      signal?.throwIfAborted();
      const result = await this.bridge.request('click', {
        tabId, snapshotId: page.snapshotId, candidateId: target.id, approved: true, autoApproved,
      }, { signal });
      // Never retry a click. Even a failed response may follow a successful action.
      return { ...decision, status: 'clicked', result: { ...result, page: validateSummary(result.page) } };
    });
  }
}
