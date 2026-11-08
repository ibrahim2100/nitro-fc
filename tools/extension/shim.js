// Runs in the page (MAIN world), before paletools.js.
// Provides the GM_xmlhttpRequest function that the userscript expects, by
// handing the request to the extension (bridge.js -> background.js).
(function () {
  if (typeof window.GM_xmlhttpRequest === 'function') return;

  let counter = 0;
  const pending = new Map();

  window.addEventListener('message', (e) => {
    if (e.source !== window || !e.data || e.data.__paletools !== 'res') return;
    const req = pending.get(e.data.id);
    if (!req) return;
    pending.delete(e.data.id);
    const r = e.data.result || {};
    if (r.error) {
      if (typeof req.onerror === 'function') req.onerror({ status: 0, responseText: String(r.error), error: String(r.error) });
    } else if (typeof req.onload === 'function') {
      req.onload({ status: r.status, responseText: r.responseText, readyState: 4 });
    }
  });

  window.GM_xmlhttpRequest = function (details) {
    const id = ++counter;
    pending.set(id, details);
    window.postMessage(
      {
        __paletools: 'req',
        id,
        method: details.method || 'GET',
        url: String(details.url),
        data: details.data == null ? null : String(details.data),
      },
      location.origin
    );
    return { abort() { pending.delete(id); } };
  };
})();
