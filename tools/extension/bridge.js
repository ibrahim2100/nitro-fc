// Runs in the extension's isolated world on the EA web app page.
// 1) Publishes the on/off state to the page (data-nitro="on|off") so the main-world
//    script can decide whether to start.  2) Relays fetch requests from the page
//    (shim.js) to the background worker.
chrome.storage.local.get({ enabled: true }, ({ enabled }) => {
  document.documentElement.setAttribute('data-nitro', enabled === false ? 'off' : 'on');
});

window.addEventListener('message', (e) => {
  if (e.source !== window || !e.data || e.data.__paletools !== 'req') return;
  const { id, method, url, data } = e.data;
  const reply = (result) =>
    window.postMessage({ __paletools: 'res', id, result }, location.origin);
  try {
    chrome.runtime.sendMessage({ type: 'paletools-fetch', method, url, data }, (result) => {
      if (chrome.runtime.lastError) reply({ error: chrome.runtime.lastError.message });
      else reply(result || { error: 'no response' });
    });
  } catch (err) {
    reply({ error: String(err && err.message || err) });
  }
});
