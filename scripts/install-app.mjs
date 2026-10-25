import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { verifyBuild, sha256 } from './build-metadata.mjs';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..'); process.chdir(root);
if (process.platform !== 'darwin') throw new Error('Applications installation requires macOS.');
const source=path.join(root,'src-tauri/target/release/bundle/macos/AI Proxy.app');
const destination='/Applications/AI Proxy.app', report='src-tauri/target/install-report.json';
const run=(command,args) => { const result=spawnSync(command,args,{encoding:'utf8'}); if (result.error || result.status !== 0) throw new Error(`${command}: ${result.error?.message || result.stderr}`); return result.stdout; };
const stopped=() => {
  const output=run('/bin/ps',['-axo','pid=,comm=']);
  return !output.split('\n').some(line=>/\/AI Proxy\.app\/Contents\/MacOS\/(ai-proxy|ai-proxy-engine)(\s|$)|\/(ai-proxy|ai-proxy-engine)(\s|$)/.test(line));
};
const record=(value) => fs.writeFileSync(report,JSON.stringify({at:new Date().toISOString(),...value},null,2)+'\n');
run('/usr/bin/codesign',['--verify','--deep','--strict',source]);
const build=verifyBuild(source);
if (!stopped()) { record({status:'deferred-running',destination}); console.log('AI Proxy/engine is running; installation deferred without stopping or overwriting it.'); process.exit(0); }
const suffix=new Date().toISOString().replace(/[:.]/g,'-');
const stage=`/Applications/.AI Proxy.install-${suffix}.app`, backup=`/Applications/.AI Proxy.backup-${suffix}.app`;
if (fs.existsSync(destination) && (fs.lstatSync(destination).isSymbolicLink() || !fs.statSync(destination).isDirectory())) throw new Error('Refusing to replace a symlink or non-directory destination.');
let moved=false, installed=false;
try {
  run('/usr/bin/ditto',[source,stage]); run('/usr/bin/codesign',['--verify','--deep','--strict',stage]);
  for (const [name,hash] of Object.entries(build.binaries)) if (sha256(`${stage}/Contents/MacOS/${name}`) !== hash) throw new Error('Staged binary mismatch.');
  if (!stopped()) { record({status:'deferred-running',destination}); console.log('App started during staging; installation deferred.'); process.exitCode=0; }
  else {
    if (fs.existsSync(destination)) { fs.renameSync(destination,backup); moved=true; }
    fs.renameSync(stage,destination); installed=true;
    run('/usr/bin/codesign',['--verify','--deep','--strict',destination]);
    for (const [name,hash] of Object.entries(build.binaries)) if (sha256(`${destination}/Contents/MacOS/${name}`) !== hash) throw new Error('Installed binary mismatch.');
    record({status:'installed',destination,backup:moved?backup:null,...build}); console.log(`Installed ${destination}; ${moved ? `previous app saved at ${backup}; ` : ''}not launched.`);
  }
} catch(error) {
  if (installed && fs.existsSync(destination)) fs.renameSync(destination,stage);
  if (moved) fs.renameSync(backup,destination);
  record({status:'failed',rolledBack:moved,error:String(error)}); throw error;
} finally { if (fs.existsSync(stage)) fs.rmSync(stage,{recursive:true,force:true}); }
