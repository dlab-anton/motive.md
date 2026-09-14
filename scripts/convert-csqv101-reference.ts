import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { checkCirclePackingWitness, CSQV_WITNESS_FORMAT } from '../src/lib/circle-packing.ts';

const EXPECTED_RAW_SHA256 = '257fcd9b51a9916a1bbb0bf1f1b06050663a8597513ee0330365b1892e8300f4';
const EXPECTED_OBJECTIVE = '5.29109518547430697';
const MAX_RAW_BYTES = 16 * 1024;
const decimal = /^(?:0|1|0\.[0-9]+|1\.0+)$/;
const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

function convert(raw: string) {
  const match = /^\s*\{\s*"n"\s*:\s*101\s*,\s*"circles"\s*:\s*\[([\s\S]*)\]\s*\}\s*$/.exec(raw);
  if (!match) throw new Error('Reference must have exact ordered n/circles structure.');
  const body = match[1];
  let cursor = 0;
  const space = () => { while ([' ', '\t', '\r', '\n'].includes(body[cursor] ?? '')) cursor += 1; };
  const expect = (token: string) => { space(); if (body[cursor] !== token) throw new Error(`Expected ${token} at offset ${cursor}.`); cursor += 1; };
  const coordinate = () => {
    space();
    const found = /^(?:0\.[0-9]+|1\.0+|0|1)/.exec(body.slice(cursor));
    if (!found || !decimal.test(found[0])) throw new Error(`Expected a plain unit-interval decimal at offset ${cursor}.`);
    cursor += found[0].length;
    return found[0];
  };
  const circles: Array<{ x: string; y: string; r: string }> = [];
  while (circles.length < 101) {
    if (circles.length) expect(',');
    expect('['); const x = coordinate(); expect(','); const y = coordinate(); expect(','); const r = coordinate(); expect(']');
    circles.push({ x, y, r });
  }
  space();
  if (cursor !== body.length) throw new Error('Unexpected reference data after circle 101.');
  return `${JSON.stringify({ format: CSQV_WITNESS_FORMAT, n: 101, circles })}\n`;
}

if (process.argv.length !== 4) {
  console.error('Usage: node --import tsx scripts/convert-csqv101-reference.ts <raw-csqv101.json> <witness.json>');
  process.exit(2);
}

const input = resolve(process.argv[2]);
const output = resolve(process.argv[3]);
if (input === output) throw new Error('Input and output paths must differ.');
const raw = await readFile(input);
if (raw.length < 1 || raw.length > MAX_RAW_BYTES) throw new Error(`Raw reference must be at most ${MAX_RAW_BYTES} bytes.`);
if (sha256(raw) !== EXPECTED_RAW_SHA256) throw new Error('Raw reference SHA-256 does not match the frozen upstream bytes.');
const witness = convert(raw.toString('utf8'));
const checked = checkCirclePackingWitness(witness);
if (!checked.ok || checked.report.objective.exact_decimal !== EXPECTED_OBJECTIVE) throw new Error('Converted witness failed its exact local check.');
await mkdir(dirname(output), { recursive: true });
try {
  const existing = await readFile(output);
  if (!existing.equals(Buffer.from(witness))) throw new Error('Refusing to overwrite a different existing witness.');
} catch (error) {
  if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  await writeFile(output, witness, { encoding: 'utf8', flag: 'wx' });
}
console.log(JSON.stringify({ input, raw_sha256: sha256(raw), output, witness_sha256: sha256(Buffer.from(witness)), report: checked.report }, null, 2));
