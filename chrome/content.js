(() => {
  // executeScript may run this file again after same-document navigation.
  if (globalThis.__piBrowserInstalled) return;
  globalThis.__piBrowserInstalled = true;
  let snapshot;
  let evidenceSnapshot;
  const invalidate = () => { snapshot = undefined; evidenceSnapshot = undefined; };
  const observer = new MutationObserver(invalidate);
  observer.observe(document, { subtree: true, childList: true, attributes: true, characterData: true });

  const clean = (text, max = 240) => String(text ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
  const visible = (el) => {
    if (el.closest('[hidden], [inert], [aria-hidden="true"], [aria-disabled="true"]')) return false;
    const rect = el.getBoundingClientRect();
    if (!rect.width || !rect.height) return false;
    for (let node = el; node; node = node.parentElement) {
      const style = getComputedStyle(node);
      if (style.display === 'none' || style.visibility !== 'visible' || Number(style.opacity) === 0) return false;
    }
    return true;
  };
  // Use the same exclusion rules for page text, labels and surrounding context.
  function textOf(root, max) {
    if (!root) return { text: '', truncated: false };
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    const chunks = [];
    let count = 0;
    let length = 0;
    let truncated = false;
    while (walker.nextNode()) {
      if (++count > 10_000 || length >= max) { truncated = true; break; }
      const parent = walker.currentNode.parentElement;
      if (!parent || parent.closest('script, style, noscript, template, input, textarea, select, [contenteditable]') || !visible(parent)) continue;
      const text = clean(walker.currentNode.textContent, max + 1);
      if (text) { chunks.push(text); length += text.length + 1; }
    }
    return { text: chunks.join('\n').slice(0, max), truncated: truncated || length > max };
  }
  const describe = (el) => {
    if (!(el instanceof HTMLAnchorElement) || !el.isConnected || !visible(el) ||
        el.closest('textarea, select, [contenteditable]') || el.hasAttribute('download') ||
        !['', '_self'].includes(el.target.toLowerCase())) return null;
    let url;
    try { url = new URL(el.href); } catch { return null; }
    if (!['http:', 'https:'].includes(url.protocol) || url.origin !== location.origin || url.username || url.password || url.href.length > 2048) return null;
    const labelled = (el.getAttribute('aria-labelledby') ?? '').split(/\s+/)
      .map((id) => textOf(document.getElementById(id), 240).text).join(' ');
    const label = clean(el.getAttribute('aria-label') || labelled.trim() || textOf(el, 240).text ||
      el.querySelector('img')?.alt || el.title || url.pathname);
    return { label, href: url.href, context: clean(textOf(el.parentElement, 300).text, 300) };
  };
  const flush = () => { if (observer.takeRecords().length) invalidate(); };
  const CLIENT_TEXT_MAX = 4_000;
  const CLIENT_LINK_MAX = 12;
  const STOP_WORDS = new Set(['a', 'an', 'and', 'at', 'by', 'for', 'from', 'in', 'into', 'is', 'of', 'on', 'or', 'the', 'to', 'with']);
  const tokens = (value) => {
    const result = new Set();
    for (const raw of String(value ?? '').toLowerCase().match(/[a-z0-9]+/g) ?? []) {
      if (raw.length < 2 || STOP_WORDS.has(raw)) continue;
      result.add(raw);
      if (raw.length > 3 && raw.endsWith('s')) result.add(raw.slice(0, -1));
    }
    return result;
  };
  const overlap = (wanted, value) => {
    let matches = 0;
    for (const token of tokens(value)) if (wanted.has(token)) matches++;
    return matches;
  };
  function rankLinks(goal, links) {
    const wanted = tokens(goal);
    const phrase = String(goal).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
    return links.map((link, index) => {
      const score = overlap(wanted, link.label) * 8 + overlap(wanted, link.context) * 3 + overlap(wanted, link.href) * 2 +
        (phrase && link.label.toLowerCase().includes(phrase) ? 20 : 0);
      return { link, index, score };
    }).sort((a, b) => b.score - a.score || a.index - b.index).slice(0, 48)
      .map(({ link: { id, label, href } }) => ({ id, label, href }));
  }

  const clientPage = (page) => ({
    snapshotId: page.snapshotId, url: page.url, title: page.title,
    text: page.text.slice(0, CLIENT_TEXT_MAX),
    textTruncated: page.textTruncated || page.text.length > CLIENT_TEXT_MAX,
    links: [...page.links].sort((a, b) => Number(Boolean(b.content)) - Number(Boolean(a.content)))
      .slice(0, CLIENT_LINK_MAX).map(({ id, label, href }) => ({ id, label, href })),
    linksTruncated: page.linksTruncated || page.links.length > CLIENT_LINK_MAX,
  });

  function read(grantId, mode = 'full', goal = '') {
    flush();
    const links = [];
    const elements = new Map();
    let linkBytes = 0;
    let linksTruncated = false;
    let scanned = 0;
    const readableRoot = document.querySelector('main, [role="main"], article') || document.body || document.documentElement;
    for (const el of document.querySelectorAll('a[href]')) {
      if (++scanned > 5000) { linksTruncated = true; break; }
      const item = describe(el);
      if (!item) continue;
      linkBytes += new TextEncoder().encode(JSON.stringify(item)).length + 30;
      if (links.length === 254 || linkBytes > 60_000) { linksTruncated = true; break; }
      const id = `e${links.length + 1}`;
      links.push({ id, ...item, content: readableRoot.contains(el) });
      elements.set(id, { el, item });
    }
    if (mode === 'candidates' && (!goal || goal.length > 2000)) throw new Error('Invalid navigation goal');
    const body = mode === 'candidates' ? { text: '', truncated: false } : textOf(readableRoot, CLIENT_TEXT_MAX);
    if (location.href.length > 8192) throw new Error('Page URL exceeds snapshot budget');
    const page = {
      snapshotId: crypto.randomUUID(), url: location.href, title: clean(document.title, 300),
      text: body.text, textTruncated: body.truncated, links, linksTruncated,
    };
    snapshot = { page, elements, grantId, created: Date.now() };
    if (mode === 'candidates') {
      return { snapshotId: page.snapshotId, url: page.url, title: page.title, candidates: rankLinks(goal, links), candidatesTruncated: linksTruncated || links.length > 48 };
    }
    if (mode === 'summary') {
      return { snapshotId: page.snapshotId, url: page.url, title: page.title, text: page.text, textTruncated: page.textTruncated };
    }
    return mode === 'read' ? clientPage(page) : page;
  }

  function currentEvidence(args) {
    flush();
    if (!evidenceSnapshot || evidenceSnapshot.id !== args.snapshotId || evidenceSnapshot.grantId !== args.grantId ||
        evidenceSnapshot.url !== location.href || evidenceSnapshot.title !== clean(document.title, 300) ||
        Date.now() - evidenceSnapshot.observedAt > 120_000) throw new Error('Stale evidence; query the page again');
    return evidenceSnapshot;
  }

  function query(args) {
    if (typeof args.question !== 'string' || !args.question.trim() || args.question.length > 2000 ||
        (args.claim !== undefined && (typeof args.claim !== 'string' || !args.claim.trim() || args.claim.length > 2000))) {
      throw new Error('Invalid browser question or claim');
    }
    const cursor = args.cursor ?? 0;
    if (!Number.isInteger(cursor) || cursor < 0 || (cursor > 0 && typeof args.snapshotId !== 'string')) {
      throw new Error('Invalid evidence cursor');
    }
    let source;
    if (args.snapshotId !== undefined) {
      source = currentEvidence(args);
      if (source.question !== args.question || source.claim !== args.claim) throw new Error('Evidence question changed; start a new query');
    } else {
      flush();
      if (location.href.length > 2048) throw new Error('Page URL exceeds evidence budget');
      const root = document.querySelector('main, [role="main"], article') || document.body || document.documentElement;
      const body = textOf(root, 100_000);
      const wanted = tokens(`${args.question} ${args.claim ?? ''}`);
      const passages = [];
      for (let start = 0; start < body.text.length; start += 840) {
        const text = body.text.slice(start, start + 1000);
        passages.push({ id: `p${start}`, start, text });
        if (start + 1000 >= body.text.length) break;
      }
      // Lexical relevance is an ordering, not an exclusion: every captured span is pageable.
      passages.sort((a, b) => overlap(wanted, b.text) - overlap(wanted, a.text) || a.start - b.start);
      source = evidenceSnapshot = { id: crypto.randomUUID(), grantId: args.grantId,
        url: location.href, title: clean(document.title, 300), observedAt: Date.now(),
        question: args.question, claim: args.claim, passages, textTruncated: body.truncated };
    }
    if (cursor > source.passages.length) throw new Error('Evidence cursor out of range');
    const passages = source.passages.slice(cursor, cursor + 16);
    const next = cursor + passages.length;
    return { snapshotId: source.id, url: source.url, title: source.title, observedAt: source.observedAt,
      passages, cursor, totalPassages: source.passages.length, textTruncated: source.textTruncated,
      nextCursor: next < source.passages.length ? next : null };
  }

  function click(args) {
    flush();
    if (!snapshot || snapshot.grantId !== args.grantId || snapshot.page.snapshotId !== args.snapshotId ||
        snapshot.page.url !== location.href || Date.now() - snapshot.created > 120_000) {
      throw new Error('Stale snapshot; read the page again');
    }
    const entry = snapshot.elements.get(args.candidateId);
    if (!entry || args.approved !== true || Date.now() >= args.expiresAt) throw new Error('Click not authorized or expired');
    const { el, item } = entry;
    if (JSON.stringify(describe(el)) !== JSON.stringify(item)) throw new Error('Link changed or is no longer actionable');
    el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
    flush();
    if (!snapshot || JSON.stringify(describe(el)) !== JSON.stringify(item)) throw new Error('Page changed while targeting link');
    const rect = el.getBoundingClientRect();
    const hit = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2);
    if (!hit || !(hit === el || el.contains(hit))) throw new Error('Link is obstructed');
    if (Date.now() >= args.expiresAt) throw new Error('Click expired');
    snapshot = undefined; // One-shot even if click handler throws or navigation fails.
    el.click();
    return { action: 'clicked', href: item.href };
  }

  chrome.runtime.onMessage.addListener((message, sender, reply) => {
    if (sender.id !== chrome.runtime.id) return;
    if (message?.type === 'dom_revoke') { invalidate(); reply({ result: true }); return; }
    if (!['dom_read', 'dom_candidates', 'dom_summary', 'dom_click', 'dom_query', 'dom_query_validate'].includes(message?.type)) return;
    try {
      if (message.origin !== location.origin || typeof message.grantId !== 'string') throw new Error('Origin or sharing grant mismatch');
      if (!Number.isFinite(message.expiresAt) || Date.now() >= message.expiresAt) throw new Error('Request expired');
      const result = message.type === 'dom_query' ? query(message) :
        message.type === 'dom_query_validate' ? { snapshotId: currentEvidence(message).id } :
          message.type === 'dom_read' ? read(message.grantId, 'read') :
        message.type === 'dom_candidates' ? read(message.grantId, 'candidates', message.goal) :
          message.type === 'dom_summary' ? read(message.grantId, 'summary') : click(message);
      reply({ result });
    } catch (error) { reply({ error: error.message }); }
  });
})();
