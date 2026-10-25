import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { verifyBuild } from './build-metadata.mjs';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
process.chdir(root);
const flags = new Set(process.argv.slice(2));
for (const arg of flags) if (!['--skip-build', '--require-notarized'].includes(arg)) throw new Error(`Unknown argument: ${arg}`);
if (process.platform !== 'darwin') throw new Error('Release packaging requires macOS.');
function run(command, args, capture = false) {
  const result = spawnSync(command, args, {cwd: root, encoding: 'utf8', stdio: capture ? 'pipe' : 'inherit'});
  if (result.error || result.status !== 0) throw new Error(`${command} failed: ${result.error?.message || result.stderr || result.status}`);
  return result.stdout?.trim() || '';
}
const pkg = JSON.parse(fs.readFileSync('package.json'));
const version = pkg.version;
const jsonVersions = ['package-lock.json', 'src-tauri/tauri.conf.json'].map(name => JSON.parse(fs.readFileSync(name)).version);
const tomlVersions = ['src-tauri/Cargo.toml', 'engine/pyproject.toml'].map(name => fs.readFileSync(name,'utf8').match(/^version = "([^"]+)"/m)?.[1]);
if ([...jsonVersions,...tomlVersions].some(value => value !== version)) throw new Error('Version manifests disagree; use npm run version:set -- X.Y.Z.');
if (!flags.has('--skip-build')) { run('npm', ['run','engine:freeze']); run('npm', ['run','app:build']); }
const app = path.join(root, 'src-tauri/target/release/bundle/macos/AI Proxy.app');
run('/usr/bin/codesign', ['--verify','--deep','--strict', app]);
const provenance = verifyBuild(app);
const bundledVersion = run('/usr/libexec/PlistBuddy', ['-c','Print :CFBundleShortVersionString',path.join(app,'Contents/Info.plist')], true);
if (bundledVersion !== version) throw new Error('App version differs from source; rebuild first.');
const main = path.join(app,'Contents/MacOS/ai-proxy'), sidecar = path.join(app,'Contents/MacOS/ai-proxy-engine');
const arch = run('/usr/bin/lipo', ['-archs',main], true);
if (!['arm64','x86_64'].includes(arch) || run('/usr/bin/lipo',['-archs',sidecar],true) !== arch) throw new Error('Main/sidecar architectures disagree or are unsupported.');
const platform = arch === 'arm64' ? 'macos-arm64' : 'macos-x64';
const signature = spawnSync('/usr/bin/codesign',['-dv','--verbose=4',app],{encoding:'utf8'}).stderr || '';
const notarized = spawnSync('xcrun',['stapler','validate',app],{encoding:'utf8'}).status === 0;
if (flags.has('--require-notarized') && (!notarized || signature.includes('Signature=adhoc'))) throw new Error('A Developer ID signed and stapled notarized application is required.');
const out = path.join(root,'release',version,platform);
if (fs.existsSync(out)) throw new Error(`Refusing to overwrite existing release: ${out}`);
const stage = fs.mkdtempSync(path.join(os.tmpdir(),'ai-proxy-release-'));
fs.mkdirSync(out,{recursive:true});
const sha = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const dirty = !!run('git',['status','--porcelain'],true);
const metadata = {version, platform, createdAt:new Date().toISOString(), commit:run('git',['rev-parse','HEAD'],true), dirtyWorkingTree:dirty, sourceSha256:provenance.sourceSha256, notarized, signing:signature.includes('Signature=adhoc')?'ad-hoc':'identity-signed', manualAcceptance:'pending', binaries:{'ai-proxy':sha(main),'ai-proxy-engine':sha(sidecar)}};
try {
  const copied = path.join(stage,'AI Proxy.app');
  run('/usr/bin/ditto',[app,copied]);
  fs.symlinkSync('/Applications',path.join(stage,'应用程序'));
  for (const name of ['LICENSE','THIRD_PARTY_NOTICES.md']) fs.copyFileSync(name,path.join(stage,name));
  const notices = path.join(out,'notices');
  run(path.join(root,'engine/.venv/bin/python'), ['scripts/collect-licenses.py',notices]);
  const review = JSON.parse(fs.readFileSync(path.join(notices,'license-review.json')));
  metadata.licenseTextReviewCount = review.length;
  if (flags.has('--require-notarized') && review.length) throw new Error('License texts require review before public distribution.');
  fs.cpSync(notices,path.join(stage,'notices'),{recursive:true});
  const install = `# AI 抓包助手 ${version} 安装说明\n\n平台：${platform === 'macos-arm64' ? 'Apple 芯片 Mac（M 系列）' : 'Intel Mac'}。签名：${metadata.signing === 'ad-hoc' ? '临时签名' : '身份签名'}；Apple 公证：${notarized ? '已完成' : '未完成'}。\n\n打开磁盘映像，将 AI Proxy.app 拖到「应用程序」，再从该目录打开。应用包含 Python 引擎，无需另装 Python、Node 或 Rust。\n\n${notarized ? '包内包含公证票据；目标 Mac 上的实际运行仍需核对。' : '本版本为开发预览，macOS 可能要求在「系统设置 → 隐私与安全性」中核准打开。请先核对来源，不要关闭系统保护。'}\n\n本地抓包和离线导入不需要模型账户。在「帮助」中选择手机、本机或离线导入；新项目默认不解密 HTTPS。HTTPS 需要在设备上安装并信任项目证书；AI 分析需配置自己的模型服务。\n\n升级前退出旧应用，并备份完整应用数据目录，不能只备份数据库。当前仍有人工验收未完成。需要核查的许可证文本：${review.length} 项，详见 notices/license-review.json；第三方原始许可与源码位置见 notices 目录。\n`;

  fs.writeFileSync(path.join(stage,'INSTALL.md'),install); fs.writeFileSync(path.join(out,'INSTALL.md'),install);
  fs.writeFileSync(path.join(stage,'build.json'),JSON.stringify(metadata,null,2)+'\n');
  const prefix = `AI-Proxy-${version}-${platform}${notarized?'':'-preview'}`;
  const zip = path.join(out,prefix+'.zip'), dmg=path.join(out,prefix+'.dmg');
  run('/usr/bin/ditto',['-c','-k',stage,zip]);
  run('/usr/bin/hdiutil',['create','-volname',`AI 抓包助手 ${version}`,'-srcfolder',stage,'-format','UDZO',dmg]);
  run('/usr/bin/hdiutil',['verify',dmg]);
  metadata.assets = [zip,dmg].map(file=>({name:path.basename(file),bytes:fs.statSync(file).size,sha256:sha(file)}));
  fs.writeFileSync(path.join(out,'build.json'),JSON.stringify(metadata,null,2)+'\n');
  fs.writeFileSync(path.join(out,'SHA256SUMS'),metadata.assets.map(file=>`${file.sha256}  ${file.name}`).join('\n')+'\n');
  fs.copyFileSync(path.join(out,'SHA256SUMS'),path.join(out,`AI-Proxy-${version}-${platform}-SHA256SUMS.txt`));
  fs.copyFileSync(path.join(out,'build.json'),path.join(out,`AI-Proxy-${version}-${platform}-build.json`));
  fs.copyFileSync(`docs/release-notes-${version}.md`,path.join(out,'RELEASE-NOTES.md'));
  console.log(`Prepared ${out}; no tag, upload, release or app launch performed.`);
} catch (error) { fs.writeFileSync(path.join(out,'INCOMPLETE.txt'),String(error)+'\n'); throw error; }
finally { fs.rmSync(stage,{recursive:true,force:true}); }
