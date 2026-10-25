import fs from 'node:fs';
import path from 'node:path';
import { sha256 } from './build-metadata.mjs';
const version=JSON.parse(fs.readFileSync('package.json')).version;
for (const platform of ['macos-arm64','macos-x64']) {
  const dir=path.join('release',version,platform), metadata=JSON.parse(fs.readFileSync(path.join(dir,'build.json')));
  if (metadata.version !== version || metadata.platform !== platform || metadata.dirtyWorkingTree || fs.existsSync(path.join(dir,'INCOMPLETE.txt'))) throw new Error(`Release provenance incomplete: ${platform}`);
  for (const asset of metadata.assets) {
    if (path.basename(asset.name) !== asset.name || sha256(path.join(dir,asset.name)) !== asset.sha256) throw new Error(`Checksum mismatch: ${asset.name}`);
  }
}
console.log('Both clean-checkout build manifests and asset checksums verified.');
