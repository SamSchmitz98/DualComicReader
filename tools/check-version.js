// The version lives in three places, because the file is shipped two ways:
//   - the userscript header      (what Tampermonkey/Violentmonkey read)
//   - the VERSION fallback       (used when GM_info is absent, i.e. as an extension)
//   - manifest.json              (what Chrome reads)
// They must agree, or a shared copy reports the wrong version in its banner.
//
//   node tools/check-version.js          -> verify
//   node tools/check-version.js 0.9.3    -> set all three

const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const scriptPath = path.join(root, 'dcui-two-page.user.js');
const manifestPath = path.join(root, 'manifest.json');

let script = fs.readFileSync(scriptPath, 'utf8');
let manifest = fs.readFileSync(manifestPath, 'utf8');

const HEADER = /(\/\/ @version\s+)(\S+)/;
const FALLBACK = /(GM_info\.script\.version\) \|\| ')([^']+)(')/;
const MANIFEST = /("version":\s*")([^"]+)(")/;

const next = process.argv[2];
if (next) {
  if (!/^\d+\.\d+\.\d+$/.test(next)) {
    console.error('version must look like 1.2.3');
    process.exit(2);
  }
  script = script.replace(HEADER, '$1' + next).replace(FALLBACK, '$1' + next + '$3');
  manifest = manifest.replace(MANIFEST, '$1' + next + '$3');
  fs.writeFileSync(scriptPath, script);
  fs.writeFileSync(manifestPath, manifest);
}

const found = {
  'userscript header': (HEADER.exec(script) || [])[2],
  'VERSION fallback': (FALLBACK.exec(script) || [])[2],
  'manifest.json': (MANIFEST.exec(manifest) || [])[2],
};

const values = new Set(Object.values(found));
for (const [where, v] of Object.entries(found)) console.log(where.padEnd(20) + (v || 'NOT FOUND'));

if (values.size !== 1 || values.has(undefined)) {
  console.error('\nversions disagree');
  process.exit(1);
}
console.log('\nok - ' + [...values][0]);
