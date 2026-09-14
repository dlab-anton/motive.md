import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { runJoinedLinuxGatewayHarness } from '../packages/runner-codex/src/joined-linux-harness.ts';

const databaseUrl = process.env.MOTIVE_TEST_DATABASE_URL;
if (!databaseUrl) throw new Error('MOTIVE_TEST_DATABASE_URL is required.');
const outputPath = resolve(process.argv[2] ?? 'fixtures/compatibility/evidence/codex-linux-gateway-0.153.4.json');
const evidence = await runJoinedLinuxGatewayHarness(databaseUrl);
await mkdir(resolve(outputPath, '..'), { recursive: true });
await writeFile(outputPath, `${JSON.stringify(evidence, null, 2)}\n`, 'utf8');
process.stdout.write(`${JSON.stringify({ status: evidence.status, outputPath, cleanup: evidence.cleanup }, null, 2)}\n`);
if (evidence.status !== 'passed') process.exitCode = 1;
