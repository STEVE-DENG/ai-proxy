"""Collect notices from installed locked dependencies without importing the app."""
from pathlib import Path
from importlib import metadata
import json
import hashlib
import re
import subprocess
import sys

root = Path(__file__).resolve().parent.parent
output = Path(sys.argv[1])
notices = ["# 分发依赖与许可证声明\n", "根据已安装的锁定依赖与当前 Cargo 目标图生成，保守列入构建工具；列入不代表全部打包。许可证及上游原文保持原语言。标准条款模板不替代上游署名，作者及原有声明另行保留。缺失文本须在再分发前核查。\n"]
source_locations = ["# 第三方依赖源码获取\n", "以下为锁定版本的上游源码位置。项目未修改这些依赖；保留其原有许可证。标准MIT文本中的占位署名不用于替代上游作者，具体归属见依赖声明中的包署名和源码。\n"]
missing = []
supplements = json.loads((root/'third-party/license-sources.json').read_text())


def license_files(folder):
    return [p for p in folder.iterdir() if p.is_file() and re.match(r"^(licen[sc]e|copying|notice)([.\-_]|$)", p.name, re.I)]

def add(ecosystem, name, version, expression, texts):
    notices.append(f"\n## {ecosystem}: {name} {version}\n\n声明许可：{expression or '未声明'}\n")
    if ecosystem == 'Cargo':
        source_url = f'https://crates.io/api/v1/crates/{name}/{version}/download'
    elif ecosystem == 'Python':
        source_url = f'https://pypi.org/project/{name}/{version}/#files'
    elif ecosystem == 'npm':
        source_url = f'https://registry.npmjs.org/{name}/-/{name.split("/")[-1]}-{version}.tgz'
    else:
        source_url = f'https://www.python.org/downloads/release/python-{version.replace(".", "")}/'
    source_locations.append(f'- {ecosystem} `{name} {version}`：{source_url}（{expression or "许可未声明"}）')
    for record in supplements:
        if (record['ecosystem'], record['name'], record['version']) != (ecosystem, name, version):
            continue
        source = root/'third-party'/record['file']
        if hashlib.sha256(source.read_bytes()).hexdigest() != record['sha256']:
            raise ValueError(f'License supplement checksum mismatch: {source}')
        text = source.read_text()
        notices.append(f"\nUpstream supplement: {record['source']}\n")
        if record.get('selectedLicense'):
            notices.append(f"\n本次选择的许可：{record['selectedLicense']}。上游包署名：{', '.join(record.get('upstreamAuthors', [])) or '见原始源码'}。原始包源码：{record['packageSource']}\n")
        # An upstream overview can be useful but is not a complete license grant.
        if 'Permission is hereby granted' in text or 'Redistribution and use' in text or (record.get('canonicalText') and record.get('selectedLicense') == 'MPL-2.0' and 'Mozilla Public License' in text):
            texts.append((record['file'], text))
        else:
            notices.append('\n' + text)
    for filename, text in texts:
        notices.append(f"\n### {filename}\n\n```text\n{text.rstrip()}\n```\n")
    if not texts:
        missing.append({"ecosystem": ecosystem, "name": name, "version": version, "license": expression})
        notices.append("\nLicense text not found in installed package; review required.\n")

lock = json.loads((root/'package-lock.json').read_text())
for rel, entry in sorted(lock['packages'].items()):
    if not rel or entry.get('dev') or not rel.startswith('node_modules/'):
        continue
    folder = root/rel
    if not folder.exists():
        raise RuntimeError(f'Missing installed dependency: {rel}')
    pkg = json.loads((folder/'package.json').read_text())
    add('npm', pkg['name'], pkg['version'], pkg.get('license', ''), [(p.name, p.read_text(errors='replace')) for p in license_files(folder)])
for dist in sorted(metadata.distributions(), key=lambda item: item.metadata.get('Name','').lower()):
    name = dist.metadata.get('Name', 'unknown')
    if name == 'ai-proxy-engine':
        continue
    texts = []
    for rel in dist.files or []:
        if re.search(r'(licen[sc]e|copying|notice)', rel.name, re.I):
            p = Path(dist.locate_file(rel))
            if p.is_file():
                texts.append((str(rel), p.read_text(errors='replace')))
    if name == 'publicsuffix2':
        header = Path(dist.locate_file('publicsuffix2/__init__.py')).read_text().split('\n\"\"\"', 1)[0]
        texts.append(('publicsuffix2 source copyright and MIT grant', header))
    add('Python', name, dist.version, dist.metadata.get('License-Expression') or dist.metadata.get('License') or '', texts)
target = subprocess.run(['rustc', '--print', 'host-tuple'], check=True, capture_output=True, text=True).stdout.strip()
result = subprocess.run(['cargo', 'metadata', '--locked', '--offline', '--filter-platform', target, '--format-version', '1', '--manifest-path', str(root/'src-tauri/Cargo.toml')], check=True, capture_output=True, text=True)
for pkg in sorted(json.loads(result.stdout)['packages'], key=lambda p:(p['name'],p['version'])):
    if pkg['name'] == 'ai-proxy':
        continue
    folder = Path(pkg['manifest_path']).parent
    candidates = license_files(folder)
    if pkg.get('license_file'):
        p = folder/pkg['license_file']
        if p.exists() and p not in candidates:
            candidates.append(p)
    add('Cargo', pkg['name'], pkg['version'], pkg.get('license') or '', [(p.name, p.read_text(errors='replace')) for p in candidates])
# Include the CPython runtime itself; PyInstaller freezes it into the sidecar.
import sysconfig
runtime_license = Path(sysconfig.get_path('stdlib'))/'LICENSE.txt'
add('runtime', 'CPython', sys.version.split()[0], 'Python-2.0', [('LICENSE.txt', runtime_license.read_text())] if runtime_license.exists() else [])
output.mkdir(parents=True, exist_ok=True)
(output/'DEPENDENCY-NOTICES.md').write_text('\n'.join(notices))
(output/'SOURCE-LOCATIONS.md').write_text('\n'.join(source_locations)+'\n')
(output/'license-review.json').write_text(json.dumps(missing, indent=2)+'\n')
print(f'Collected dependency notices; {len(missing)} packages need license-text review (see license-review.json).')
