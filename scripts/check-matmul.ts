import { open } from 'node:fs/promises';
import { resolve } from 'node:path';
import { checkMatmulWitness, MATMUL_4X4X4_PROFILE, MATMUL_MAX_BYTES, type MatmulProfile } from '../src/lib/matmul.ts';

const usage = 'Usage: npm run check:matmul -- <scheme.json> [--shape AxBxC --reference-rank R]';
const args = process.argv.slice(2);
const positional: string[] = [];
const options = new Map<string, string>();
for (let index = 0; index < args.length; index += 1) {
  if (args[index].startsWith('--')) { options.set(args[index], args[index + 1] ?? ''); index += 1; }
  else positional.push(args[index]);
}
const option = (name: string) => options.get(name);
if (positional.length !== 1) { console.error(usage); process.exit(2); }

let profile: MatmulProfile = MATMUL_4X4X4_PROFILE;
const shape = option('--shape'), referenceRank = option('--reference-rank');
if (shape || referenceRank) {
  const dimensions = /^(\d+)x(\d+)x(\d+)$/.exec(shape ?? '');
  if (!dimensions || !referenceRank || !/^\d+$/.test(referenceRank)) { console.error(usage); process.exit(2); }
  profile = { ...MATMUL_4X4X4_PROFILE, shape: [Number(dimensions[1]), Number(dimensions[2]), Number(dimensions[3])], referenceRank: Number(referenceRank) };
}

try {
  const handle = await open(resolve(positional[0]), 'r');
  let source: string;
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size < 1 || stat.size > MATMUL_MAX_BYTES) throw new Error(`Scheme must be a regular file of at most ${MATMUL_MAX_BYTES} bytes.`);
    const bytes = Buffer.alloc(stat.size + 1);
    const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
    if (bytesRead !== stat.size) throw new Error('Scheme changed while it was being read.');
    source = bytes.subarray(0, bytesRead).toString('utf8');
  } finally { await handle.close(); }
  const result = checkMatmulWitness(source, profile);
  console.log(JSON.stringify(result, null, 2));
  if (!result.ok) process.exitCode = 1;
} catch (error) {
  console.error(JSON.stringify({ ok: false, error: { code: 'READ_FAILED', message: error instanceof Error ? error.message : 'Unable to read scheme.' } }, null, 2));
  process.exitCode = 2;
}
