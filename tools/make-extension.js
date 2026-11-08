// Turns the built userscript into an unpacked Chrome (MV3) extension folder.
// usage: node tools/make-extension.js <paletools-ar.user.js> <out-dir>
const fs = require('fs');
const path = require('path');
const acorn = require('acorn');
const brand = require('./brand/brand');
const cfg = JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json'), 'utf8'));

const [, , inp, outDir] = process.argv;
if (!inp || !outDir) {
  console.error('usage: node tools/make-extension.js <paletools-ar.user.js> <out-dir>');
  process.exit(1);
}
const src = fs.readFileSync(inp, 'utf8');
const hm = /^\/\/ ==UserScript==[\s\S]*?\/\/ ==\/UserScript==\n/.exec(src);
if (!hm) throw new Error('userscript header not found');
const header = hm[0];
const body = src.slice(hm[0].length);

// "27.2.1-ar.1" -> "27.2.1.1" (Chrome wants up to 4 numeric parts)
const ver = /@version\s+(\S+)/.exec(header)[1];
const m = /^(\d+(?:\.\d+)*)(?:-ar\.(\d+))?$/.exec(ver);
if (!m) throw new Error('unexpected version: ' + ver);
const chromeVersion = m[2] ? m[1] + '.' + m[2] : m[1];

// wrap like a userscript manager does, so nothing leaks into the page's globals
// ...and only start when the popup switch is on (bridge.js publishes data-nitro on <html>)
const wrapped =
  ';(function(){\n' +
  'function __start(){\n' + body + '\n}\n' +
  'var __de=document.documentElement,__t0=Date.now();\n' +
  '(function __wait(){var v=__de.getAttribute("data-nitro");' +
  'if(v==="on")__start();else if(v!=="off"&&Date.now()-__t0<3000)setTimeout(__wait,50);})();\n' +
  '})();\n';
acorn.parse(wrapped, { ecmaVersion: 'latest' });

fs.rmSync(outDir, { recursive: true, force: true });
fs.mkdirSync(outDir, { recursive: true });
const tpl = path.join(__dirname, 'extension');
for (const f of ['shim.js', 'bridge.js', 'background.js', 'popup.js', 'popup.css']) {
  fs.copyFileSync(path.join(tpl, f), path.join(outDir, f));
}
const fill = (t) =>
  t.replace(/__NAME__/g, cfg.scriptName).replace(/__DESC__/g, cfg.brand.description)
    .replace(/__BRAND_AR__/g, cfg.brand.ar).replace(/__BRAND_EN__/g, cfg.brand.en);
fs.writeFileSync(path.join(outDir, 'popup.html'), fill(fs.readFileSync(path.join(tpl, 'popup.html'), 'utf8')));
const manifest = fill(fs.readFileSync(path.join(tpl, 'manifest.json'), 'utf8')).replace('__VERSION__', chromeVersion);
JSON.parse(manifest);
fs.writeFileSync(path.join(outDir, 'manifest.json'), manifest);
fs.mkdirSync(path.join(outDir, 'icons'));
for (const s of [16, 32, 48, 128]) {
  fs.writeFileSync(path.join(outDir, 'icons', `icon-${s}.png`), brand.png(s));
  fs.writeFileSync(path.join(outDir, 'icons', `icon-off-${s}.png`), brand.png(s, true));
}
fs.writeFileSync(path.join(outDir, 'paletools.js'), wrapped);
console.log(`extension v${chromeVersion} -> ${outDir} (${fs.readdirSync(outDir).join(', ')})`);
