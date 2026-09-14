import { open } from 'node:fs/promises';
import { resolve } from 'node:path';
import { checkCirclePackingWitness, CSQV_MAX_BYTES } from '../src/lib/circle-packing.ts';

if (process.argv.length !== 3) {
  console.error('Usage: npm run check:circle-packing -- <witness.json>');
  process.exit(2);
}

try {
  const handle = await open(resolve(process.argv[2]), 'r');
  let source: string;
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size < 1 || stat.size > CSQV_MAX_BYTES) throw new Error(`Witness must be a regular file of at most ${CSQV_MAX_BYTES} bytes.`);
    const bytes = Buffer.alloc(stat.size + 1);
    const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
    if (bytesRead !== stat.size) throw new Error('Witness changed while it was being read.');
    source = bytes.subarray(0, bytesRead).toString('utf8');
  } finally { await handle.close(); }
  const result = checkCirclePackingWitness(source);
  console.log(JSON.stringify(result, null, 2));
  if (!result.ok) process.exitCode = 1;
} catch (error) {
  console.error(JSON.stringify({ ok: false, error: { code: 'READ_FAILED', message: error instanceof Error ? error.message : 'Unable to read witness.' } }, null, 2));
  process.exitCode = 2;
}
