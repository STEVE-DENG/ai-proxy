import fs from 'node:fs';
const version = process.argv[2];
if (!/^\d+\.\d+\.\d+$/.test(version || '')) throw new Error('Usage: node scripts/set-version.mjs 0.2.0');
const changes = new Map();
for (const name of ['package.json', 'package-lock.json', 'src-tauri/tauri.conf.json']) {
  const data = JSON.parse(fs.readFileSync(name, 'utf8')); data.version = version;
  if (data.packages?.['']) data.packages[''].version = version;
  changes.set(name, JSON.stringify(data, null, 2)+'\n');
}
for (const [file, block] of [['src-tauri/Cargo.toml', '[package]'], ['engine/pyproject.toml', '[project]']]) {
  const text = fs.readFileSync(file, 'utf8');
  const start = text.indexOf(block), end = text.indexOf('\n[', start+block.length);
  const part = text.slice(start, end < 0 ? undefined : end).replace(/^version = "[^"]+"/m, `version = "${version}"`);
  changes.set(file, text.slice(0,start)+part+(end < 0 ? '' : text.slice(end)));
}
for (const [file, name] of [['src-tauri/Cargo.lock','ai-proxy'],['engine/uv.lock','ai-proxy-engine']]) {
  const text = fs.readFileSync(file, 'utf8');
  const pattern = new RegExp(`(\\[\\[package\\]\\]\\nname = "${name}"\\nversion = ")[^"]+(")`);
  if (!pattern.test(text)) throw new Error(`Missing root package in ${file}`);
  changes.set(file, text.replace(pattern, `$1${version}$2`));
}
for (const [file, text] of changes) fs.writeFileSync(file, text);
console.log(`Updated ${changes.size} manifests/lockfiles to ${version}; dependency versions unchanged.`);
