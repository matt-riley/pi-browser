# Pi Browser

A Chrome companion that gives Pi a **persistent browser connection to the tabs you share**. Pi owns the goal, Jev chooses from DOM-derived candidates, and deterministic code validates every action. Pi can use only tabs you share from the popup, and every click asks you first.

```text
Pi tools → authenticated loopback WebSocket → Chrome MV3 worker → isolated DOM script
                       ↓
              Jev (TypeSafe API, called by Pi)
```

No screenshots, debugger permission, cloud relay, cookie export, or second sidebar chatbot.

## Try it

Requires Node 22.18+, Pi (tested with 1.5.0), Chrome 116+, and a TypeSafe API key.

```sh
cd /path/to/pi-browser
npm ci --legacy-peer-deps
# TYPESAFE_API_KEY must be available in the environment that starts Pi.
pi -e ./src/index.js
```

1. In Chrome, open `chrome://extensions`, enable **Developer mode**, select **Load unpacked**, and choose this repo's `chrome/` directory. No build is needed.
2. In Pi, run **`/browser`** once. Copy the port and pairing token from its dialog into the Chrome extension popup, then select **Pair with Pi**. The token is shown only in command UI, not returned to the model.
3. On a tab you want Pi to use, open the extension popup and select **Share this tab**. Opening the popup is what gives the extension access to that tab; it has no access to any site otherwise.
4. Ask Pi about the tab. It can list shared tabs, read them, query them, and use Jev to choose an eligible link. Every click asks you in Pi first.
5. Use **Stop sharing this tab** to take a tab back. Use the popup's **Disconnect & stop all** to revoke persistent pairing, or **`/browser reset`** to also rotate the token (only when no other Pi session is connected). **`/browser stop`** disconnects just the session you run it in, and revokes the pairing only if no other Pi session is connected.

Pairing persists across Pi reloads, Chrome worker restarts and browser restarts, so you only pair once. Shared tabs don't persist: sharing ends when you stop it, close the tab, move the tab to another site, or Chrome restarts the extension. Links within the same site keep the tab shared. The popup hides setup once paired and distinguishes **pairing saved / reconnecting** from **not paired**.

Reconnect normally takes seconds. A stopped Chrome worker is woken by a one-minute alarm (Chrome may delay it); browser startup also triggers reconnect. Pi waits up to eight seconds for a connection **before** dispatch, never replays an action. Don't use `/browser stop`, `/browser reset`, or **Disconnect & stop all** as a reconnect button: they disconnect on purpose.

### Several Pi sessions

**Several Pi sessions can use the browser at once.** They share one port, one token and one Chrome pairing:

- The first session to start owns the port (the *hub*). It holds the Chrome connection.
- Later sessions see the port is busy and **join the hub** over the same WebSocket port, on the `/pi` path, using the saved token. They don't warn or log while they do it.
- The hub relays each session's commands to Chrome and sends results back to the session that asked.
- If the hub's session exits or reloads, a remaining session **takes the port over** quietly and Chrome reconnects to it. Shared tabs stay shared through the handover. Commands that were in flight fail with *Browser disconnected* and are never replayed. Read before retrying.
- `/browser` in any session shows the same port and token. `/browser stop` disconnects only the session that runs it; the others stay connected and Chrome stays paired. In the last connected session it also revokes the Chrome pairing. `/browser reset` refuses while any other Pi session is connected: all sessions and Chrome share one token, so a new token would cut the others off. It changes nothing and says how many other sessions are connected; run `/browser stop` in them first. In the only session, it rotates the token and Chrome must pair again.

**Every session can use every tab you share**, including sessions that join later. There's no per-session sharing:

| Tab | Who can use it |
| --- | --- |
| Shared with **Share this tab** | Every connected Pi session. |
| Any tab you haven't shared | No session. |

When a session ends, the tabs you shared stay shared with the others. Click approvals appear in the session that asked for the click.

Keep `PI_BROWSER_STATE_PATH` and port overrides the same in every session, or sessions can't find each other. If `/browser` says the port is busy and not answering as a Pi browser bridge, another program holds it; set `PI_BROWSER_PORT` to a free port. Port `0` is for isolated tests, not persistent daily use.

Local helpers use `.ts` so Pi's transpiled module graph refreshes them on `/reload`. Native `.js` helper imports can stay cached in a running Pi process even when the entry point reloads. The installed-Pi regression test changes bridge source before reloading and checks that the new code actually executes. No build step is required; standalone checks use Node's built-in type stripping.

For persistent Pi loading, optionally run `pi install /absolute/path/to/pi-browser`. That changes your Pi settings; the steps above do not.

## Tools

| Tool | Behavior |
| --- | --- |
| `browser_tabs()` | Page-sized overview of shared tabs; `more` counts the rest |
| `browser_find_tab({ goal })` | Jev chooses a shared tab without activating or navigating it |
| `browser_read({ tabId })` | Bounded DOM text (2,000 characters) and eligible links |
| `browser_query({ tabId, question, claim?, detail?, snapshotId?, cursor? })` | Compact finding or claim verdict by default; full excerpts only with `detail: "evidence"` |
| `browser_follow_link({ tabId, goal })` | Jev chooses an eligible same-origin link, then asks you before clicking it |

Selection returns `selected`, `uncertain`, or `no_match`. Link actions also return `denied` or `clicked`. Inspect `result.page` after a click; `result.observationError` means the click occurred but a fresh page could not be observed. A new snapshot is an observation, **not proof that the overall goal succeeded**.

### Targeted evidence

Use `browser_query` for specific questions instead of repeatedly reading the preview:

```js
browser_query({ tabId: 123, question: 'Which checks are pending for head d189f9f?',
  claim: 'All checks passed for head d189f9f.' })
```

Chrome captures up to **100,000 visible text characters / 10,000 text nodes**, splits them into overlapping 1,000-character passages, and ranks them locally. Only **16 passages per call** go through the Pi process to Jev. This is internal tool traffic, **not Pi conversation context**.

The default result contains only a status, source URL, evidence IDs, snapshot/cursor and compact coverage. Without a claim, Jev also selects a **verbatim finding of at most 320 characters**. With a claim, the verdict itself is the answer: no claim repetition or excerpt dump. Jev chooses from bounded source spans; it does not generate summaries. Raw passages, title, timestamp, verbose coverage and probability maps stay out of the default result's `content`, `structuredContent` **and** `details`.

```js
// Default: compact answer only.
const answer = browser_query({ tabId: 123, question: 'Which head has passed checks?' });
// Only when evidence is needed; reuse the exact question/claim and returned snapshot/cursor.
browser_query({ tabId: 123, question: 'Which head has passed checks?',
  snapshotId: answer.snapshotId, cursor: answer.cursor, detail: 'evidence' });
```

- Open-question statuses are `evidence`, `uncertain`, `no_match_in_batch`, or `needs_evidence` when no short candidate safely answers. **No-match does not prove absence.** A finding is untrusted source text, not an instruction or an independently verified fact.
- `coverage` is `captured_dom` only when one call covers all captured passages without capture/evidence truncation; otherwise `partial`. It never claims to cover unloaded content, the whole site or external truth.
- If `nextCursor` is present, pass it as `cursor` alongside `snapshotId` and the **same question and claim**. Each call examines another bounded batch; the tool never loops or navigates automatically. A new query replaces the previous query snapshot for that tab.
- A claim returns `supports`, `contradicts`, `not_established`, or `uncertain`, scoped to **selected evidence only**. A check count is not proof of success; a description or old review does not establish current-head readiness. This is semantic evidence assessment, **not independent verification or merge authorization**.
- `detail: "evidence"` returns up to three exact excerpts / 3,000 text characters plus full provenance, coverage and continuation. A bounded in-memory cache (32 results, two-minute validity) lets you expand the same result without rerunning Jev or counting usage twice. No page-content cache is written to disk.
- The DOM, URL, grant, title and snapshot age are rechecked after inference **and on cache hits**. Changed, expired or revoked evidence fails closed; start a fresh query. Inference and excerpts remain internal unless explicitly requested.

## Boundaries and safety

- The bridge listens only on loopback. Persistent pairing uses a stable local port and a credential file at `~/.pi/pi-browser/credentials.json` with restrictive permissions by default. Set `PI_BROWSER_STATE_PATH` to change it. `/browser reset` rotates the credential.
- The Chrome extension stores the paired port/token in `chrome.storage.local` and reconnects automatically when Pi is available. The `alarms` permission provides worker wakeups; it grants no site access. `/browser stop` in the last connected session, and `/browser reset` (which only runs when no other session is connected), send an explicit revoke to a connected companion; the companion clears its profile and alarm. Use the popup's stop button to forget pairing when Pi is offline.
- The extension has no site permissions. It reaches a tab only through Chrome's `activeTab`, which you grant by opening the popup on that tab, and only after you select **Share this tab**. The model can't share tabs, open tabs or navigate to new URLs.
- **Every click asks you first**, in the Pi session that wants to click. A Pi session with no interactive UI can't click at all; it says so before reading the page or calling Jev. Jev confidence never grants authorization.
- Only rendered HTTP(S), same-origin anchor links are eligible. Downloads, new-window links, buttons, form submissions, arbitrary scripts, and other URL schemes are excluded.
- If a shared tab moves to another site, Chrome ends the extension's access and the tab stops being shared. Coming back to the first site doesn't restore it; share the tab again.
- IDs refer to original elements in one snapshot and one grant. Any observed DOM mutation, changed URL, replacement, obstruction, expiry (two minutes), or revoke invalidates a target. Dynamic pages may need another read; the tool does not silently retry clicks.
- Operations are serialized per tab. Requests have deadlines and support cancellation. Stop/revoke prevents new and queued actions; an already-dispatched click may have occurred and cannot be undone. After a disconnect, timeout, or action error, **read before retrying**.
- Pairing survives Chrome worker restarts; shared tabs and snapshot grants don't.
- Earlier versions had an allowed-sites list. On load the extension deletes any saved list and removes the Chrome site permissions it granted, so no access is left behind.
- DOM text, titles, labels and URLs are untrusted evidence. Jev gets a closed candidate set plus an explicit `none` option; it cannot invent an executable selector.
- Model-facing payloads are deliberately small: tab overviews and reads cost at most 2,000 characters each, link summaries are capped at 12, and default queries contain at most a 320-character finding. Full query excerpts are opt-in. Link navigation sends Jev only 48 `{id, label, href}` candidates, never the page body. Queries send up to 16,000 excerpt characters through Pi to Jev, without putting that batch in Pi's conversation. Tool `details` and `structuredContent` are not model-facing: only `content` is sent to the provider, so duplicating a compact result there costs session storage, not prompt tokens. Click observations contain text only. Remaining captured text and snapshot data stay in Chrome.

### Privacy

The API key stays in the Pi process; the Chrome extension never receives it. Input values, textarea content and editable content are not intentionally extracted, but ordinary visible text, URLs, labels, and surrounding link text can contain sensitive data. **Only share tabs whose content you are willing to send to TypeSafe and Pi's model provider.** The bridge itself is local; model inference is not. Compact results can be retained in Pi conversation history; full query excerpts enter it only when explicitly requested. Queries still send bounded page content to TypeSafe. This extension adds no durable page-content logs.

## Configuration

| Environment variable | Default |
| --- | --- |
| `TYPESAFE_API_KEY` | Required for Jev selection |
| `TYPESAFE_MODEL` | `jev-latest` |
| `TYPESAFE_BASE_URL` | SDK default, `https://api.typesafe.ai` |
| `PI_BROWSER_PORT` | `37123` for persistent mode, shared by every Pi session |
| `PI_BROWSER_TOKEN` | Generated and stored locally |
| `PI_BROWSER_STATE_PATH` | `~/.pi/pi-browser/credentials.json` |
| `PI_BROWSER_MIN_CONFIDENCE` | `0.7` |
| `PI_BROWSER_MIN_PROBABILITY` | `0.8` |

Both Jev gates must pass for Choice selections and claim judgments. Passage relevance uses Noul's probability gate (Noul has no separate confidence field). These are conservative **starting values**, not calibrated browser benchmarks; evaluate them on representative sites before adjusting. Selections return only the chosen candidate, confidence and probability; raw model answers and page bodies are not returned to Pi's conversation. Jev requests have a bounded overall deadline; read-only inference may retry once, browser actions never do.

## Checks

```sh
npm run check
npm test                        # Offline unit/registration tests
npx playwright install chromium
npm run test:browser             # Isolated Chromium profile; mocked Jev
npm run test:live                # Same fixture, real Jev; requires key and costs API tokens
npm run test:pi                  # Installed Pi changed-helper reload/pairing/stop regression; no model calls
```

Unit tests also connect several Pi sessions at once with a fake Chrome peer. They check that every session gets its own replies, nothing is evicted, a session can't join under another session's ID, a leaving session's in-flight commands are cancelled, the port is taken over when its owner exits, and nothing is logged. A second browser fixture pairs real Chromium with several sessions and checks that every session, including one that joins later, can use every shared tab, that no session can use a tab nobody shared, and that shares outlast a session that ends.

The browser fixture loads the shipped manifest with no host permissions and opens the popup on each tab through Chrome's extension action, so access comes only from `activeTab`. It checks pairing, persistent reconnect, unshared-tab rejection, that same-site clicks keep a tab shared and a move to another site ends sharing, link filtering, snapshots, stale-target refusal, revocation, Jev tab/link selection, actual navigation and cross-origin refusal. Reconnect checks kill the worker with the popup closed and let a real Chrome alarm wake it, restart the entire browser using the same profile, and verify explicit revocation removes the saved pairing/alarm. Query checks cover evidence beyond the preview, continuation without duplicate passage IDs, privacy exclusions, compact output budgets, opt-in cached expansion and mutations during inference. Unit tests cover no-match/uncertainty, claim gates and malformed answers; the live fixture also tests real Jev evidence selection and missing revision evidence. Tests never touch your normal Chrome profile.

## Deliberately not in this slice

Forms, buttons, downloads, arbitrary cross-origin navigation chains, iframe/shadow-DOM traversal, visual/canvas interaction, screenshots, automatic goal verification, multi-step autonomous workflows, and Chrome Web Store packaging. Synthetic DOM clicks also do not satisfy sites that require trusted physical input. Opening new tabs and clicking without asking were removed on purpose.

## References

- [Chrome activeTab](https://developer.chrome.com/docs/extensions/develop/concepts/activeTab)
- [Chrome optional host permissions](https://developer.chrome.com/docs/extensions/develop/concepts/declare-permissions)
- [Chrome service worker WebSockets](https://developer.chrome.com/docs/extensions/how-to/web-platform/websockets)
- [Chrome alarms](https://developer.chrome.com/docs/extensions/reference/api/alarms)
- [TypeSafe JavaScript SDK](https://docs.typesafe.ai/sdk/javascript.md)
- [Choice judgments](https://docs.typesafe.ai/primitives/choice.md)
- [Noul judgments](https://docs.typesafe.ai/primitives/noul.md)
