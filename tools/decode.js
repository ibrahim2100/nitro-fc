// Replaces obfuscator string-array lookups (alias(0x..)) with literal strings.
// This is semantically identical code, just readable/patchable.
// usage: node decode.js <in.js> <out.js>
const fs = require('fs');
const vm = require('vm');

function decodeFile(src) {
  const marker = ',((()=>{';
  const idx = src.indexOf(marker);
  if (idx < 0) throw new Error('rotation marker not found');
  const decoderName = /^[\s\S]*?function (a0_0x[0-9a-f]+)\(/.exec(src.slice(0, 2000))
    || /function (a0_0x[0-9a-f]+)\(/.exec(src);
  const name = decoderName[1];
  // header comment block may precede: take from first "function a0_"
  const start = src.indexOf('function ' + name + '(');
  const code = src.slice(start, idx) + ')';
  const ctx = {};
  vm.createContext(ctx);
  vm.runInContext(code + `;this.__dec=${name};`, ctx);
  const dec = ctx.__dec;

  // aliases of the decoder, and aliases of aliases (const _a=_b; ...), until stable
  const aliases = new Set([name]);
  let grew = true;
  while (grew) {
    grew = false;
    const aliasRe = new RegExp('(_0x[0-9a-f]+)\\s*=\\s*(' + [...aliases].join('|') + ')(?![\\w$(.\\[])', 'g');
    let m;
    while ((m = aliasRe.exec(src))) {
      if (!aliases.has(m[1])) { aliases.add(m[1]); grew = true; }
    }
  }

  const callRe = new RegExp('\\b(' + [...aliases].map(a => a.replace(/\$/g, '\\$')).join('|') + ')\\((0x[0-9a-f]+)\\)', 'g');
  let count = 0;
  const out = src.replace(callRe, (_, a, hex) => {
    count++;
    return JSON.stringify(dec(parseInt(hex, 16)));
  });
  return { out, count, aliases: aliases.size, name };
}

module.exports = { decodeFile };

if (require.main === module) {
  const [, , inp, outp] = process.argv;
  const src = fs.readFileSync(inp, 'utf8');
  const r = decodeFile(src);
  fs.writeFileSync(outp, r.out);
  console.log(`decoded ${r.count} lookups, ${r.aliases} aliases, decoder ${r.name}`);
}
