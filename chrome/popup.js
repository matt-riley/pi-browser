const $ = (id) => document.getElementById(id);
const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
$('tab').textContent = tab?.title || 'No active tab';

async function send(message) {
  const response = await chrome.runtime.sendMessage(message);
  if (!response) throw new Error('Browser companion did not respond; reload the extension');
  if (response.error) throw new Error(response.error);
  return response.result;
}
function renderSessions(sessions) {
  // Several Pi sessions can be connected. A shared tab belongs to the one picked here.
  const select = $('session');
  const chosen = select.value;
  select.replaceChildren(...sessions.map(({ id, label }) => {
    const option = document.createElement('option');
    option.value = id;
    option.textContent = label;
    return option;
  }));
  if (sessions.some(({ id }) => id === chosen)) select.value = chosen;
  select.hidden = sessions.length < 2;
  $('session-field').hidden = sessions.length < 2;
}
function render(state) {
  // Keep the popup compatible with a worker that was upgraded while it was running.
  const shares = Array.isArray(state?.shares) ? state.shares : [];
  const sessions = Array.isArray(state?.sessions) ? state.sessions : [];
  const owner = (Array.isArray(state?.shareSessions) ? state.shareSessions : []).find((item) => item.tabId === tab?.id);
  const ownerLabel = sessions.find(({ id }) => id === owner?.session)?.label;
  const sharing = shares.includes(tab?.id);
  renderSessions(sessions);
  $('status').textContent = state?.connected
    ? `Paired with Pi · ${sessions.length || 1} session(s) · ${shares.length} shared tab(s)` +
      (sharing ? ` · this tab is shared${ownerLabel ? ` with ${ownerLabel}` : ''}` : '')
    : state?.paired ? 'Pairing saved · reconnecting to Pi automatically. No need to pair again.'
      : 'Not paired. Run /browser in Pi once to see setup details.';
  $('pairing').hidden = Boolean(state?.paired);
  $('share').disabled = !state?.connected || sharing || !tab?.id;
  $('revoke').disabled = !sharing;
}
async function action(message) {
  try {
    const state = await send(message);
    render(state);
    return state;
  } catch (error) {
    $('status').textContent = error.message;
    throw error;
  }
}
$('pairing').addEventListener('submit', async (event) => {
  event.preventDefault();
  const token = $('token').value.trim();
  $('token').value = '';
  await action({ type: 'pair', port: Number($('port').value), token });
});
$('share').addEventListener('click', () => action({ type: 'share', tabId: tab.id, session: $('session').value || undefined }));
$('revoke').addEventListener('click', () => action({ type: 'revoke', tabId: tab.id }));
$('stop').addEventListener('click', () => action({ type: 'stop' }));
await action({ type: 'status' }).catch(() => {});
// The popup is not the reconnect engine; just reflect background connection changes.
setInterval(() => { void action({ type: 'status' }).catch(() => {}); }, 1000);
