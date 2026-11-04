const $ = (id) => document.getElementById(id);
const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
$('tab').textContent = tab?.title || 'No active tab';

async function send(message) {
  const response = await chrome.runtime.sendMessage(message);
  if (!response) throw new Error('Browser companion did not respond; reload the extension');
  if (response.error) throw new Error(response.error);
  return response.result;
}
function render(state) {
  // Keep the popup compatible with a worker that was upgraded while it was running.
  const shares = Array.isArray(state?.shares) ? state.shares : [];
  const sessions = Array.isArray(state?.sessions) ? state.sessions : [];
  const sharing = shares.includes(tab?.id);
  $('status').textContent = state?.connected
    ? `Paired with Pi · ${sessions.length || 1} session(s) · ${shares.length} shared tab(s)` +
      (sharing ? ' · this tab is shared with every Pi session' : '')
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
$('share').addEventListener('click', () => action({ type: 'share', tabId: tab.id }));
$('revoke').addEventListener('click', () => action({ type: 'revoke', tabId: tab.id }));
$('stop').addEventListener('click', () => action({ type: 'stop' }));
await action({ type: 'status' }).catch(() => {});
// The popup is not the reconnect engine; just reflect background connection changes.
setInterval(() => { void action({ type: 'status' }).catch(() => {}); }, 1000);
