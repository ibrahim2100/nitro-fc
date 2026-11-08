// Service worker: performs the (cross-origin) requests Paletools asks for,
// but only to an explicit allow-list of hosts, over https, without cookies.
const ALLOWED_HOSTS = ['fut.gg', 'futbin.com', 'futwiz.com'];
const MAX_BODY = 64 * 1024;

function hostAllowed(hostname) {
  return ALLOWED_HOSTS.some((h) => hostname === h || hostname.endsWith('.' + h));
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || msg.type !== 'paletools-fetch') return;
  // only accept requests coming from our content script on the EA web app
  if (!sender.tab || !String(sender.url || '').startsWith('https://www.ea.com/')) {
    sendResponse({ error: 'sender not allowed' });
    return;
  }
  let u;
  try { u = new URL(msg.url); } catch { sendResponse({ error: 'bad url' }); return; }
  const method = String(msg.method || 'GET').toUpperCase();
  if (u.protocol !== 'https:' || !hostAllowed(u.hostname)) {
    sendResponse({ error: 'host not allowed: ' + u.hostname });
    return;
  }
  if (method !== 'GET' && method !== 'POST') { sendResponse({ error: 'method not allowed' }); return; }
  if (msg.data != null && String(msg.data).length > MAX_BODY) { sendResponse({ error: 'body too large' }); return; }

  fetch(u.href, {
    method,
    body: method === 'POST' && msg.data != null ? String(msg.data) : undefined,
    credentials: 'omit',
    cache: 'no-store',
    redirect: 'follow',
  })
    .then(async (r) => sendResponse({ status: r.status, ok: r.ok, responseText: await r.text() }))
    .catch((err) => sendResponse({ error: String((err && err.message) || err) }));
  return true; // async response
});

// ---- toolbar state: colour icon + no badge when on, grey icon + "OFF" when off
function paintState(enabled) {
  const on = enabled !== false;
  const sizes = [16, 32, 48, 128];
  const path = {};
  sizes.forEach((s) => { path[s] = 'icons/' + (on ? 'icon-' : 'icon-off-') + s + '.png'; });
  chrome.action.setIcon({ path });
  chrome.action.setBadgeText({ text: on ? '' : 'OFF' });
  chrome.action.setBadgeBackgroundColor({ color: '#4a5a78' });
  chrome.action.setTitle({ title: on ? 'نيترو - مفعّلة' : 'نيترو - متوقفة' });
}
const refresh = () => chrome.storage.local.get({ enabled: true }, ({ enabled }) => paintState(enabled));
chrome.runtime.onInstalled.addListener(refresh);
chrome.runtime.onStartup.addListener(refresh);
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.enabled) paintState(changes.enabled.newValue);
});
refresh();
