const $ = (id) => document.getElementById(id);
const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
$('tab').textContent = tab?.title || 'No active tab';

async function send(message) {
  const response = await chrome.runtime.sendMessage(message);
  if (!response) throw new Error('Browser companion did not respond; reload the extension');
  if (response.error) throw new Error(response.error);
  return response.result;
}
function renderPolicies(policies = []) {
  $('policies').replaceChildren(...policies.map(({ origin, actions }) => {
    const item = document.createElement('li');
    const text = document.createElement('span');
    text.textContent = `${origin} · ${actions.join(', ')}`;
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'remove-policy';
    remove.dataset.origin = origin;
    remove.textContent = 'Remove';
    item.append(text, remove);
    return item;
  }));
}
function render(state) {
  // Keep the popup compatible with a worker that was upgraded while it was running.
  const shares = Array.isArray(state?.shares) ? state.shares : [];
  const policies = Array.isArray(state?.policies) ? state.policies : [];
  const sharing = shares.includes(tab?.id);
  $('status').textContent = state?.connected
    ? `Paired with Pi · ${shares.length} shared tab(s) · ${policies.length} allowed site(s)${sharing ? ' · this tab is shared' : ''}`
    : state?.paired ? 'Pairing saved · reconnecting to Pi automatically. No need to pair again.'
      : 'Not paired. Run /browser in Pi once to see setup details.';
  $('pairing').hidden = Boolean(state?.paired);
  $('share').disabled = !state?.connected || sharing || !tab?.id;
  $('revoke').disabled = !sharing;
  renderPolicies(policies);
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
$('policies').addEventListener('click', async (event) => {
  const button = event.target.closest('.remove-policy');
  if (!button) return;
  await action({ type: 'policy_remove', origin: button.dataset.origin });
});
$('policy-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  try {
    const origin = new URL($('origin').value.trim()).origin;
    const actions = ['read'];
    if ($('policy-navigate').checked) actions.push('navigate');
    if ($('policy-click').checked) actions.push('click');
    const granted = await chrome.permissions.request({ origins: [`${origin}/*`] });
    if (!granted) throw new Error('Site permission was not granted');
    await action({ type: 'policy_add', origin, actions });
    $('origin').value = '';
  } catch (error) {
    $('status').textContent = error.message;
  }
});
await action({ type: 'status' }).catch(() => {});
// The popup is not the reconnect engine; just reflect background connection changes.
setInterval(() => { void action({ type: 'status' }).catch(() => {}); }, 1000);
