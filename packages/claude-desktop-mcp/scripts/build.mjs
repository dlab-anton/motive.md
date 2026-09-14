import { copyFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

await rm(new URL('../server', import.meta.url), { recursive: true, force: true });
await mkdir(new URL('../server', import.meta.url), { recursive: true });
const result = await build({
  entryPoints: [fileURLToPath(new URL('../src/index.ts', import.meta.url))],
  outfile: fileURLToPath(new URL('../server/index.js', import.meta.url)),
  bundle: true,
  platform: 'node',
  target: 'node18',
  format: 'esm',
  sourcemap: false,
  minify: false,
  metafile: true,
  banner: { js: '#!/usr/bin/env node' },
});

const packageNames = new Set();
for (const input of Object.keys(result.metafile.inputs)) {
  const normalized = input.replaceAll('\\', '/');
  const marker = 'node_modules/';
  const index = normalized.lastIndexOf(marker);
  if (index < 0) continue;
  const parts = normalized.slice(index + marker.length).split('/');
  packageNames.add(parts[0].startsWith('@') ? `${parts[0]}/${parts[1]}` : parts[0]);
}

const packageRoot = fileURLToPath(new URL('../node_modules/', import.meta.url));
let notices = 'Third-party notices for the bundled Motive Claude Desktop extension\n\n';
for (const packageName of [...packageNames].sort()) {
  const directory = path.join(packageRoot, ...packageName.split('/'));
  const metadata = JSON.parse(await readFile(path.join(directory, 'package.json'), 'utf8'));
  let licenseText = 'License file not included by the package.';
  for (const candidate of ['LICENSE', 'LICENSE.md', 'LICENSE.txt', 'COPYING']) {
    try { licenseText = await readFile(path.join(directory, candidate), 'utf8'); break; } catch { /* Try the next standard name. */ }
  }
  notices += `${'='.repeat(72)}\n${metadata.name} ${metadata.version} — ${metadata.license ?? 'license not declared'}\n${'='.repeat(72)}\n${licenseText.trim()}\n\n`;
}
await writeFile(new URL('../THIRD_PARTY_NOTICES.txt', import.meta.url), notices, 'utf8');

const stage = new URL('../.mcpb-stage/', import.meta.url);
await rm(stage, { recursive: true, force: true });
await mkdir(new URL('server/', stage), { recursive: true });
await Promise.all([
  copyFile(new URL('../manifest.json', import.meta.url), new URL('manifest.json', stage)),
  copyFile(new URL('../README.md', import.meta.url), new URL('README.md', stage)),
  copyFile(new URL('../PRIVACY.md', import.meta.url), new URL('PRIVACY.md', stage)),
  copyFile(new URL('../../../LICENSE', import.meta.url), new URL('LICENSE', stage)),
  copyFile(new URL('../THIRD_PARTY_NOTICES.txt', import.meta.url), new URL('THIRD_PARTY_NOTICES.txt', stage)),
  copyFile(new URL('../server/index.js', import.meta.url), new URL('server/index.js', stage)),
]);
