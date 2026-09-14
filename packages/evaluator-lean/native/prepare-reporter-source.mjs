import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';

// Run only in the Docker build's exact pinned Git checkout. Keep stock Main.lean
// intact; the new module has the same trusted functions plus a distinct main.
const original = await readFile('Main.lean', 'utf8');
const suffix = await readFile('/motive-build/motive-facts-suffix.lean', 'utf8');
const marker = 'def main (args : List String) : IO Unit := do';
if (original.split(marker).length !== 2) throw new Error('Pinned Comparator entry point differs from reviewed source.');
const generated = original.replace(marker, 'def stockMain (args : List String) : IO Unit := do') + '\n' + suffix;
await writeFile('MotiveReporter.lean', generated);
const lake = await readFile('lakefile.toml', 'utf8');
await writeFile('lakefile.toml', lake + '\n[[lean_exe]]\nname = "motive_reporter"\nroot = "MotiveReporter"\n');
const sha256 = bytes => 'sha256:' + createHash('sha256').update(bytes).digest('hex');
await writeFile('/motive-build/reporter-source-identity.json', JSON.stringify({
  format: 'motive.comparator-reporter-source/0.1', comparatorCommit: '2312244ac716564a61cc0bf4e107d9abf1757a61',
  originalMainDigest: sha256(original), instrumentationDigest: sha256(suffix), generatedModuleDigest: sha256(generated),
}, null, 2) + '\n');
