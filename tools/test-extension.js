// Wiring test for shim.js -> bridge.js -> background.js using stubs
// (no real browser). usage: node tools/test-extension.js <extension-dir>
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const dir = process.argv[2];
const read = (f) => fs.readFileSync(path.join(dir, f), 'utf8');

// fake page window: postMessage -> async 'message' event with source === window
const listeners = [];
const win = {
  location: { origin: 'https://www.ea.com' },
  addEventListener: (t, fn) => t === 'message' && listeners.push(fn),
  postMessage(data) { setTimeout(() => listeners.slice().forEach((fn) => fn({ source: win, data })), 0); },
};
win.window = win;
const attrs = {};
const doc = { documentElement: { getAttribute: (k) => (k in attrs ? attrs[k] : null), setAttribute: (k, v) => (attrs[k] = v) } };
win.document = doc;

// in-memory chrome.storage.local
const store = {};
const storageListeners = [];
const storageLocal = {
  get: (defaults, cb) => { const out = { ...defaults }; for (const k in defaults) if (k in store) out[k] = store[k]; if (cb) cb(out); return Promise.resolve(out); },
  set: (obj) => { const ch = {}; for (const k in obj) { ch[k] = { oldValue: store[k], newValue: obj[k] }; store[k] = obj[k]; } storageListeners.forEach((fn) => fn(ch, 'local')); return Promise.resolve(); },
};
const action = { icon: null, badge: null, title: null,
  setIcon: (o) => (action.icon = o), setBadgeText: (o) => (action.badge = o.text),
  setBadgeBackgroundColor: () => {}, setTitle: (o) => (action.title = o.title) };

// background with stubbed chrome + fetch
let bgListener;
const fetched = [];
const bgCtx = {
  URL, console,
  chrome: {
    runtime: { onMessage: { addListener: (fn) => (bgListener = fn) }, onInstalled: { addListener: () => {} }, onStartup: { addListener: () => {} } },
    storage: { local: storageLocal, onChanged: { addListener: (fn) => storageListeners.push(fn) } },
    action,
  },
  fetch: async (url, opts) => {
    fetched.push({ url, opts });
    if (url.includes('boom')) throw new Error('network down');
    return { status: 200, ok: true, text: async () => '{"hello":"world"}' };
  },
};
vm.createContext(bgCtx);
vm.runInContext(read('background.js'), bgCtx);

// bridge (isolated) + shim (main) share the fake window
const bridgeCtx = {
  window: win, document: doc, location: win.location, chrome: { storage: { local: storageLocal, onChanged: { addListener: (fn) => storageListeners.push(fn) } }, runtime: { lastError: null, sendMessage: (msg, cb) => {
    const sender = { tab: { id: 1 }, url: 'https://www.ea.com/ea-sports-fc/ultimate-team/web-app/' };
    const keep = bgListener(msg, sender, cb);
    if (!keep) {/* sync response already delivered */}
  } } },
};
vm.createContext(bridgeCtx);
vm.runInContext(read('bridge.js'), bridgeCtx);
const mainCtx = { window: win, location: win.location, Map, String };
vm.createContext(mainCtx);
vm.runInContext(read('shim.js'), mainCtx);

const call = (details) => new Promise((resolve) => {
  win.GM_xmlhttpRequest({ ...details, onload: (r) => resolve({ ok: r }), onerror: (r) => resolve({ err: r }) });
});

(async () => {
  let failed = 0;
  const check = (name, cond, extra) => { console.log((cond ? 'PASS ' : 'FAIL ') + name, cond ? '' : JSON.stringify(extra)); if (!cond) failed++; };

  let r = await call({ method: 'GET', url: 'https://r2.fut.gg/27/manifest.json' });
  check('allowed host returns body', r.ok && r.ok.status === 200 && r.ok.responseText === '{"hello":"world"}', r);
  check('fetch sent without cookies', fetched[0] && fetched[0].opts.credentials === 'omit', fetched[0]);

  r = await call({ method: 'GET', url: 'https://pale.tools/fifa/version.txt' });
  check('pale.tools is blocked', r.err && /host not allowed/.test(r.err.responseText), r);

  r = await call({ method: 'GET', url: 'http://r2.fut.gg/x' });
  check('plain http is blocked', !!r.err, r);

  r = await call({ method: 'GET', url: 'https://evilfut.gg.attacker.com/x' });
  check('look-alike host is blocked', !!r.err, r);

  r = await call({ method: 'DELETE', url: 'https://r2.fut.gg/x' });
  check('DELETE is blocked', !!r.err, r);

  r = await call({ method: 'GET', url: 'https://r2.fut.gg/boom' });
  check('network error reaches onerror', r.err && /network down/.test(r.err.responseText), r);

  // sender check
  const resp = await new Promise((res) => bgListener({ type: 'paletools-fetch', method: 'GET', url: 'https://r2.fut.gg/x' }, { tab: { id: 2 }, url: 'https://evil.example/' }, res));
  check('foreign sender is rejected', resp && resp.error === 'sender not allowed', resp);

  // ---- on/off switch
  const flush = () => new Promise((r) => setTimeout(r, 5));
  await flush();
  check('bridge publishes data-nitro=on by default', attrs['data-nitro'] === 'on', attrs);
  check('toolbar: on => no badge, colour icon', action.badge === '' && /icon-16\.png$/.test(action.icon.path[16]), action);

  await storageLocal.set({ enabled: false });
  await flush();
  check('toolbar: off => OFF badge, grey icon', action.badge === 'OFF' && /icon-off-16\.png$/.test(action.icon.path[16]), action);

  // gate in the wrapped paletools.js
  const runGate = async (state) => {
    const a = state === null ? {} : { 'data-nitro': state };
    let started = 0;
    const ctx = { document: { documentElement: { getAttribute: (k) => (k in a ? a[k] : null) } }, Date, setTimeout };
    vm.createContext(ctx);
    const src = read('paletools.js');
    // replace the real body with a probe, keeping the generated gate code
    const probe = src.replace(/function __start\(\)\{[\s\S]*?\n\}\nvar __de/, 'function __start(){ globalThis.__started=(globalThis.__started||0)+1 }\nvar __de');
    vm.runInContext(probe, ctx);
    await new Promise((r) => setTimeout(r, 120));
    return ctx.__started || 0;
  };
  check('gate: on => starts', (await runGate('on')) === 1);
  check('gate: off => does not start', (await runGate('off')) === 0);

  // popup: toggle writes storage and reloads only EA tabs
  const reloaded = [];
  let queried;
  const els = {};
  const mkEl = () => ({ checked: false, disabled: true, textContent: '', _l: {}, addEventListener(t, fn) { this._l[t] = fn; } });
  ['sw', 'state', 'note', 'ver'].forEach((id) => (els[id] = mkEl()));
  const popCtx = {
    document: { getElementById: (id) => els[id] },
    chrome: {
      runtime: { getManifest: () => ({ version: '9.9' }) },
      storage: { local: storageLocal },
      tabs: { query: async (q) => { queried = q; return [{ id: 7 }, { id: 8 }]; }, reload: async (id) => reloaded.push(id) },
    },
    Promise,
  };
  vm.createContext(popCtx);
  vm.runInContext(read('popup.js'), popCtx);
  await flush();
  check('popup: shows stored state (off)', els.sw.checked === false && els.sw.disabled === false && els.state.textContent === 'متوقفة', els.sw);
  els.sw.checked = true;
  await els.sw._l.change();
  await flush();
  check('popup: toggle on saves + reloads EA tabs', store.enabled === true && reloaded.join() === '7,8' && queried.url.every((u) => u.startsWith('https://www.ea.com/')), { store, reloaded, queried });
  await flush();
  check('toolbar follows popup change', action.badge === '', action);

  // manifest sanity
  const mf = JSON.parse(read('manifest.json'));
  check('manifest has storage perm + popup + icons', mf.permissions.includes('storage') && mf.action.default_popup === 'popup.html' && mf.icons['128'] && fs.existsSync(path.join(dir, 'popup.html')) && fs.existsSync(path.join(dir, mf.icons['128'])), mf);
  check('no leftover placeholders', !/__NAME__|__DESC__|__BRAND|__VERSION__/.test(read('manifest.json') + read('popup.html')));

  process.exit(failed ? 1 : 0);
})();
