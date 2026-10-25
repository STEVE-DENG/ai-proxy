import fs from 'node:fs';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { verifyEngine } from './engine-metadata.mjs';
export function sourceFingerprint() {
  const names = execFileSync('git',['ls-files','--cached','--others','--exclude-standard','-z'],{encoding:'utf8'}).split('\0').filter(name => /^(src\/|src-tauri\/(src\/|icons\/|capabilities\/|Cargo\.|tauri.conf|Info\.plist|build.rs)|engine\/(ai_proxy_engine\/|pyproject|uv.lock|entrypoint)|public\/|scripts\/freeze-engine.sh|package(-lock)?\.json|vite.config|tsconfig|index.html)/.test(name) && fs.existsSync(name));
  const hash = crypto.createHash('sha256');
  for (const name of [...new Set(names)].sort()) { hash.update(name+'\0'); hash.update(fs.readFileSync(name)); }
  return hash.digest('hex');
}
export const sha256 = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
export function verifyBuild(app) {
  const file='src-tauri/target/build-metadata.json';
  if (!fs.existsSync(file)) throw new Error('Build provenance is missing; run npm run app:build.');
  const record=JSON.parse(fs.readFileSync(file));
  if (verifyEngine().sourceSha256 !== record.engineSourceSha256) throw new Error('Engine source differs from packaged provenance; rebuild.');
  if (record.sourceSha256 !== sourceFingerprint()) throw new Error('Source changed after packaging; rebuild before distribution/install.');
  for (const [name,hash] of Object.entries(record.binaries)) if (sha256(`${app}/Contents/MacOS/${name}`) !== hash) throw new Error(`Packaged binary differs from build record: ${name}`);
  return record;
}
if (process.argv[1] && fileURLToPath(import.meta.url) === fs.realpathSync(process.argv[1])) {
  const engine=verifyEngine();
  const app='src-tauri/target/release/bundle/macos/AI Proxy.app';
  const record={engineSourceSha256:engine.sourceSha256,createdAt:new Date().toISOString(),sourceSha256:sourceFingerprint(),binaries:Object.fromEntries(['ai-proxy','ai-proxy-engine'].map(name=>[name,sha256(`${app}/Contents/MacOS/${name}`)]))};
  fs.writeFileSync('src-tauri/target/build-metadata.json',JSON.stringify(record,null,2)+'\n');
  console.log('Recorded source and binary fingerprints for the packaged app.');
}
