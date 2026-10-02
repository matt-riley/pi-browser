import { readdir, readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';

for (const dir of ['src', 'chrome', 'scripts', 'test']) {
  for (const file of await readdir(dir)) {
    if (!/\.(js|ts)$/.test(file)) continue;
    const result = spawnSync(process.execPath, ['--check', `${dir}/${file}`], { stdio: 'inherit' });
    if (result.status !== 0) process.exit(result.status || 1);
  }
}
const manifest = JSON.parse(await readFile('chrome/manifest.json', 'utf8'));
if (manifest.manifest_version !== 3 || manifest.host_permissions || manifest.externally_connectable ||
    JSON.stringify(manifest.permissions) !== JSON.stringify(['activeTab', 'alarms', 'scripting', 'storage', 'tabs']) ||
    JSON.stringify(manifest.optional_host_permissions) !== JSON.stringify(['http://*/*', 'https://*/*'])) {
  throw new Error('Unexpected browser permissions');
}
console.log('Syntax and least-privilege manifest checks passed');
