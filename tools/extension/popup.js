// Popup: on/off switch. State lives in chrome.storage.local ("enabled", default true).
// On change the open EA web app tabs are reloaded so it takes effect immediately.
const EA_TABS = [
  'https://www.ea.com/*/ea-sports-fc/ultimate-team/web-app/*',
  'https://www.ea.com/ea-sports-fc/ultimate-team/web-app/*',
];
const sw = document.getElementById('sw');
const stateEl = document.getElementById('state');
const noteEl = document.getElementById('note');
document.getElementById('ver').textContent = 'v' + chrome.runtime.getManifest().version;

const render = (on) => {
  sw.checked = on;
  stateEl.textContent = on ? 'مفعّلة' : 'متوقفة';
};

chrome.storage.local.get({ enabled: true }, ({ enabled }) => {
  render(enabled !== false);
  sw.disabled = false;
});

sw.addEventListener('change', async () => {
  const on = sw.checked;
  sw.disabled = true;
  await chrome.storage.local.set({ enabled: on });
  render(on);
  const tabs = await chrome.tabs.query({ url: EA_TABS });
  await Promise.all(tabs.map((t) => chrome.tabs.reload(t.id)));
  noteEl.textContent = tabs.length
    ? 'تمت إعادة تحميل صفحة EA (' + tabs.length + ').'
    : 'لا توجد صفحة EA مفتوحة؛ سيُطبَّق التغيير عند فتحها.';
  sw.disabled = false;
});
