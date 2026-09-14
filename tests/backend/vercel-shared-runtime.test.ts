import { execFileSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

describe('Vercel shared runtime modules', () => {
  const temporaryDirectories: string[] = [];

  afterEach(async () => {
    await Promise.all(temporaryDirectories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
  });

  it('emits a Node-resolvable ESM graph for server-consumed project support', async () => {
    const outputDirectory = await mkdtemp(join(tmpdir(), 'motive-vercel-shared-'));
    temporaryDirectories.push(outputDirectory);
    const sourceRoot = resolve('src/lib');
    execFileSync(process.execPath, [
      resolve('node_modules/typescript/bin/tsc'),
      resolve(sourceRoot, 'support.ts'),
      resolve(sourceRoot, 'projects.ts'),
      '--ignoreConfig',
      '--outDir', outputDirectory,
      '--rootDir', sourceRoot,
      '--module', 'ESNext',
      '--moduleResolution', 'Bundler',
      '--target', 'ES2022',
      '--allowImportingTsExtensions',
      '--rewriteRelativeImportExtensions',
      '--noCheck',
    ], { stdio: 'pipe' });

    const emittedUrl = pathToFileURL(join(outputDirectory, 'support.js')).href;
    const output = execFileSync(process.execPath, [
      '--input-type=module',
      '--eval',
      `const module = await import(${JSON.stringify(emittedUrl)}); process.stdout.write(JSON.stringify(module.restoreState({ following: ['circle-packing'] })));`,
    ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    expect(JSON.parse(output)).toEqual({ following: ['circle-packing'] });
  });
});
