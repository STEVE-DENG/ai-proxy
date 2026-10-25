import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const digest = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
export function engineFingerprint() {
  const names=['engine/pyproject.toml','engine/uv.lock','engine/entrypoint.py'];
  const walk = folder => { for(const entry of fs.readdirSync(folder,{withFileTypes:true})) { const name=path.join(folder,entry.name); if(entry.isDirectory() && entry.name !== '__pycache__') walk(name); else if(entry.isFile() && name.endsWith('.py')) names.push(name); } };
  walk('engine/ai_proxy_engine');
  const hash=crypto.createHash('sha256');
  for (const name of names.sort()) { hash.update(name+'\0'); hash.update(fs.readFileSync(name)); }
  return hash.digest('hex');
}
export function verifyEngine() {
  const file='src-tauri/binaries/engine-build.json';
  if (!fs.existsSync(file)) throw new Error('Frozen-engine provenance missing; run npm run engine:freeze.');
  const record=JSON.parse(fs.readFileSync(file));
  const target=execFileSync('rustc',['--print','host-tuple'],{encoding:'utf8'}).trim();
  if (record.target !== target || record.sourceSha256 !== engineFingerprint() || digest(record.binary) !== record.binarySha256) throw new Error('Frozen sidecar is stale or mismatched; run npm run engine:freeze.');
  return record;
}
if (process.argv[1] && fileURLToPath(import.meta.url) === fs.realpathSync(process.argv[1])) {
  const target=execFileSync('rustc',['--print','host-tuple'],{encoding:'utf8'}).trim();
  const binary=`src-tauri/binaries/ai-proxy-engine-${target}`;
  fs.writeFileSync('src-tauri/binaries/engine-build.json',JSON.stringify({target,binary,sourceSha256:engineFingerprint(),binarySha256:digest(binary),createdAt:new Date().toISOString()},null,2)+'\n');
  console.log('Recorded frozen-engine source and binary provenance.');
}
