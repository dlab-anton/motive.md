import { readFile } from 'node:fs/promises';
import { redactHarnessEvidence, runLocalCompatibilityHarness } from './harness.ts';

const CAPABILITY_PATH = '/exchange/capability';
const GATEWAY_BASE_URL = 'http://gateway:8080/v1';

const capability = (await readFile(CAPABILITY_PATH, 'utf8')).trim();
if (!/^[A-Za-z0-9_-]{32,512}$/.test(capability)) throw new Error('The joined harness capability is missing or invalid.');

const evidence = redactHarnessEvidence(await runLocalCompatibilityHarness('happy', {
  externalGateway: { baseUrl: GATEWAY_BASE_URL, capability },
}));
process.stdout.write(`MOTIVE_CODEX_EVIDENCE ${JSON.stringify(evidence)}\n`);
if (evidence.status !== 'passed') process.exitCode = 1;
