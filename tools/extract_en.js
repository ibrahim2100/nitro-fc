// Extracts the locale dictionary (en/es/it/...) from a decoded script.
// usage: node extract_en.js <decoded.js> <out.json>
const fs = require('fs');
const acorn = require('acorn');

function keyName(p) {
  return p.key.type === 'Identifier' ? p.key.name : p.key.value;
}

function extractLocales(src) {
  const ast = acorn.parse(src, {
    ecmaVersion: 'latest',
    allowReturnOutsideFunction: true,
  });
  let found = null;
  (function walk(n) {
    if (found || !n || typeof n.type !== 'string') return;
    if (n.type === 'ObjectExpression') {
      const keys = n.properties.filter(p => p.type === 'Property').map(keyName);
      if (keys.includes('en') && keys.includes('es') && keys.includes('fr') && keys.includes('de')) {
        found = n;
        return;
      }
    }
    for (const k in n) {
      const v = n[k];
      if (Array.isArray(v)) v.forEach(walk);
      else if (v && typeof v.type === 'string') walk(v);
    }
  })(ast);
  if (!found) throw new Error('locale dictionary not found');
  const out = {};
  for (const lang of found.properties) {
    const lname = keyName(lang);
    const dict = {};
    for (const p of lang.value.properties) {
      if (p.value.type === 'Literal') dict[keyName(p)] = p.value.value;
    }
    out[lname] = dict;
  }
  return { out, node: found };
}

module.exports = { extractLocales };

if (require.main === module) {
  const [, , inp, outp] = process.argv;
  const { out, node } = extractLocales(fs.readFileSync(inp, 'utf8'));
  fs.writeFileSync(outp, JSON.stringify(out, null, 1));
  for (const l of Object.keys(out)) console.log(l, Object.keys(out[l]).length);
  console.log('dict at', node.start, node.end);
}
