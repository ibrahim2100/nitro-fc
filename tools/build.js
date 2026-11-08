// Builds the Arabic / trimmed Paletools userscript from the official file.
// usage: node tools/build.js <official.user.js> <output.user.js>
// Every patch must match exactly once, otherwise the build fails (so a new
// upstream version can never be silently half-patched).
const fs = require('fs');
const path = require('path');
const acorn = require('acorn');
const { decodeFile } = require('./decode');
const { extractLocales } = require('./extract_en');
const brand = require('./brand/brand');

const [, , inp, outp] = process.argv;
if (!inp || !outp) {
  console.error('usage: node tools/build.js <official.user.js> <output.user.js>');
  process.exit(1);
}
const cfg = JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json'), 'utf8'));
const ar = JSON.parse(fs.readFileSync(path.join(__dirname, 'ar.json'), 'utf8'));
// rename the product inside the Arabic strings (single place: config.json "brand")
for (const k of Object.keys(ar)) ar[k] = ar[k].replace(/PALETOOLS|Paletools/g, cfg.brand.ar);

let src = fs.readFileSync(inp, 'utf8');

function replaceOnce(label, text, re, fn) {
  const matches = [...text.matchAll(new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g'))];
  if (matches.length !== 1) {
    throw new Error(`patch "${label}" expected 1 match, got ${matches.length}`);
  }
  const m = matches[0];
  const rep = typeof fn === 'function' ? fn(m) : fn;
  console.log(`  ok  ${label}`);
  return text.slice(0, m.index) + rep + text.slice(m.index + m[0].length);
}

// ---- 0. split header
const hm = /^\/\/ ==UserScript==[\s\S]*?\/\/ ==\/UserScript==\n/.exec(src);
if (!hm) throw new Error('userscript header not found');
let header = hm[0];
let body = src.slice(hm[0].length);

// ---- 1. readable code: resolve obfuscator string lookups to literals
const dec = decodeFile(body);
body = dec.out;
console.log(`  ok  decoded ${dec.count} string lookups`);

// ---- 2. Arabic dictionary + force language
{
  // add "ar" to the locale dictionary (position found via AST)
  const { node } = extractLocales(body);
  const json = JSON.stringify(ar);
  body = body.slice(0, node.start + 1) + `"ar":${json},` + body.slice(node.start + 1);
  console.log(`  ok  added "ar" dictionary (${Object.keys(ar).length} strings)`);

  const lang = JSON.stringify(cfg.forceLanguage);
  body = replaceOnce(
    'force UI language',
    body,
    /services\[["']Localization["']\]\[["']locale["']\]\[["']language["']\]/,
    lang
  );
}

// ---- 3. remove plugins (skip run() and their settings entry)
{
  const names = JSON.stringify(cfg.removePlugins);
  body = replaceOnce(
    'skip removed plugins (' + cfg.removePlugins.join(', ') + ')',
    body,
    /for\(let (\w+) of (\w+)\)\{if\(!\1\[(["'])run\3\]\)continue;/,
    (m) =>
      `for(let ${m[1]} of ${m[2]}){if(!${m[1]}[${m[3]}run${m[3]}])continue;` +
      `if(${names}.includes((${m[1]}.settings||{}).name))continue;`
  );
}

// ---- 3b. hide banners: neutralise plugins identified by a unique marker string
{
  const ast = acorn.parse(body, { ecmaVersion: 'latest', allowReturnOutsideFunction: true });
  const edits = [];
  const walk = (n, anc) => {
    if (!n || typeof n.type !== 'string') return;
    if (n.type === 'Literal' && cfg.removePluginMarkers.includes(n.value)) {
      const objs = anc.filter(
        (a) => a.type === 'ObjectExpression' && a.properties.some((p) => p.key && (p.key.name === 'run' || p.key.value === 'run'))
      );
      const o = objs[objs.length - 1];
      if (!o) throw new Error('no plugin object around marker ' + n.value);
      const run = o.properties.find((p) => p.key && (p.key.name === 'run' || p.key.value === 'run'));
      edits.push({ marker: n.value, start: run.value.start, end: run.value.end });
    }
    const next = anc.concat(n);
    for (const k in n) {
      const v = n[k];
      if (Array.isArray(v)) v.forEach((c) => walk(c, next));
      else if (v && typeof v.type === 'string') walk(v, next);
    }
  };
  walk(ast, []);
  for (const m of cfg.removePluginMarkers) {
    const c = edits.filter((e) => e.marker === m).length;
    if (c !== 1) throw new Error(`marker "${m}" expected once, got ${c}`);
  }
  edits.sort((a, b) => b.start - a.start);
  for (const e of edits) {
    body = body.slice(0, e.start) + 'function(){}' + body.slice(e.end);
    console.log(`  ok  hidden banner plugin (${e.marker})`);
  }
}

// ---- 3c. rename the visible product name outside the dictionaries
body = replaceOnce(
  'hideout dropdown label',
  body,
  /\{(['"])label\1:(['"])Paletools\2,(['"])value\3:(['"])paletools\4\}/,
  (m) => `{${m[1]}label${m[1]}:${m[2]}${cfg.brand.en}${m[2]},${m[3]}value${m[3]}:${m[4]}paletools${m[4]}}`
);

// ---- 3d. logo images (inline data URIs)
body = replaceOnce('logo image', body, /(['"])logosvg\1:(['"])data:image\/svg\+xml;base64,[A-Za-z0-9+\/=]+\2/, (m) =>
  `${m[1]}logosvg${m[1]}:${m[2]}${brand.dataUri(brand.logoSvg())}${m[2]}`
);
body = replaceOnce('wordmark image', body, /(['"])logosvgtext\1:(['"])data:image\/svg\+xml;base64,[A-Za-z0-9+\/=]+\2/, (m) =>
  `${m[1]}logosvgtext${m[1]}:${m[2]}${brand.dataUri(brand.wordmarkSvg(cfg.brand.en.toUpperCase()))}${m[2]}`
);

// ---- 3e. Nitro solver hooks (steer Paletools' built-in Smart Builder; see tools/nitro/solver.js)
{
  // candidate ordering: the comparator that takes (a, b, preferStorage=false)
  body = replaceOnce(
    'nitro: comparator hook',
    body,
    /function\((\w+),(\w+),(\w+)=!0x1\)\{(const \w+=\w+;)if\(\3\)\{const (\w+)=Number\(/,
    (m) =>
      `function(${m[1]},${m[2]},${m[3]}=!0x1){${m[4]}{const __c=globalThis.__nitroCmp&&globalThis.__nitroCmp(${m[1]},${m[2]});if(__c)return __c;}` +
      `if(${m[3]}){const ${m[5]}=Number(`
  );
  // prices must be known before candidates are sorted
  body = replaceOnce(
    'nitro: price prefetch hook',
    body,
    /(\w+)=(\w+)\(\),(\w+)=(\w+)\[["']useStorage["']\]\|\|\4\[["']storageOnly["']\]\?await (\w+)\((\w+)\):\[\];let /,
    (m) => `${m[0].slice(0, -4)}await(globalThis.__nitroPrefetch&&globalThis.__nitroPrefetch([...${m[1]},...${m[3]}]));let `
  );
  // expose the external price lookup (fut.gg bulk prices) to the hook
  body = replaceOnce(
    'nitro: expose price lookup',
    body,
    /async function (\w+)\((\w+)\)\{return new Promise\((\w+)=>\{const (\w+)=a0_0xbac6;(\w+)\[["']push["']\]\(\{['"]resolve['"]:\3,['"]items['"]:\2,['"]prices['"]:\{\}\}\)/,
    (m) => `globalThis.__nitroPriceFn=${m[1]};` + m[0]
  );
  // main players excluded completely: also the storage copies of players in the active squad
  body = replaceOnce(
    'nitro: exclude squad players from storage too',
    body,
    /(\w+)\[["']has["']\]\((\w+)\[["']definitionId["']\]\)&&!(\w+)\(\2\)\|\|/,
    (m) => `${m[1]}["has"](${m[2]}["definitionId"])&&(globalThis.__nitroActive||!${m[3]}(${m[2]}))||`
  );
  // expensive players are kept out of the candidate list (the hook is a no-op outside Nitro runs)
  body = replaceOnce(
    'nitro: block expensive players',
    body,
    /=>!\(!(\w+)\|\|\1\[["']loans["']\]>-0x1\|\|/,
    (m) => `=>!(!${m[1]}||${m[1]}["loans"]>-0x1||(globalThis.__nitroBlocked&&globalThis.__nitroBlocked(${m[1]}))||`
  );
  // wrap the Smart Builder button action: summary after the run
  body = replaceOnce(
    'nitro: wrap smart builder run',
    body,
    /const (\w+)=await (\w+)\((\w+),this\[["']config["']\]\);if\(\1\[["']success["']\]\)/,
    (m) =>
      `const ${m[1]}=await(globalThis.__nitroSolve?globalThis.__nitroSolve((__x)=>${m[2]}(${m[3]},__x?Object.assign({},this["config"],__x):this["config"]),${m[3]}):${m[2]}(${m[3]},this["config"]));if(${m[1]}["success"])`
  );
  body = ['solver.js', 'sbc.js', 'points.js', 'settings.js'].map((f) => fs.readFileSync(path.join(__dirname, 'nitro', f), 'utf8')).join('\n') + '\n' + body;
  console.log('  ok  nitro solver module prepended');
}

// ---- 4. header
for (const needle of cfg.removeHeaderLines) {
  const re = new RegExp('^// ' + needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '.*\\n', 'm');
  if (!re.test(header)) throw new Error('header line not found: ' + needle);
  header = header.replace(re, '');
}
header = header.replace(/^\/\/ @name .*$/m, '// @name ' + cfg.scriptName);
header = header.replace(/^\/\/ @version (\S+)$/m, (_, v) => '// @version ' + v + cfg.versionSuffix);
header = header.replace(/^\/\/ @description .*$/m, '// @description ' + cfg.brand.description);
console.log('  ok  header');

const out = header + body;

// ---- 5. verify result parses
acorn.parse(body, { ecmaVersion: 'latest', allowReturnOutsideFunction: true });
console.log('  ok  syntax check');

fs.writeFileSync(outp, out);
console.log(`wrote ${outp} (${(out.length / 1024).toFixed(0)} KB)`);

// ---- 6. report untranslated keys (new upstream strings)
const { out: loc } = extractLocales(body);
const skip = (k) => /^plugins\.(snipe|autoSnipe)\./.test(k);
const missing = Object.keys(loc.en).filter((k) => !skip(k) && !(k in loc.ar));
if (missing.length) {
  console.log(`\n${missing.length} English strings without Arabic (they fall back to English):`);
  missing.forEach((k) => console.log('  ' + k + ' = ' + String(loc.en[k]).slice(0, 80)));
}
