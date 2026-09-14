import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

export type ReviewedWritebackContract = Readonly<{
  fileDigest: string;
  contractVersion: 'hypothesis-http-writeback-capabilities/2' | 'hypothesis-http-writeback-capabilities/3';
  apiVersion: '1.8.0';
  schemaRevision: '017_write_idempotency';
  surfaceDigest: string;
  implementationDigest: string;
}>;

export const LEGACY_REVIEWED_WRITEBACK_CONTRACT: ReviewedWritebackContract = Object.freeze({
  fileDigest: 'sha256:890d29b73511b2a3922ed1fd165c9cc4f1779d205118403406551420bf027aa4',
  contractVersion: 'hypothesis-http-writeback-capabilities/2',
  apiVersion: '1.8.0', schemaRevision: '017_write_idempotency',
  surfaceDigest: '6586d546ef57af3633b94978e594da0a536ae3b7dc84c892a0875aba916caf47',
  implementationDigest: '5df840cefe905da907c62af4fafac6b14bafd97e97e4727b5ee189bb37ec321c',
});

export const PINNED_REVIEWED_WRITEBACK_CONTRACT: ReviewedWritebackContract = Object.freeze({
  fileDigest: 'sha256:ddd18ff4ea1c98c51db4971e1aaeafe217d2c00f5625fae545414419c6349102',
  contractVersion: 'hypothesis-http-writeback-capabilities/3',
  apiVersion: '1.8.0', schemaRevision: '017_write_idempotency',
  surfaceDigest: 'c42a174eba3f293bcb2165c298ccb1750aff0ce6e8800c82ed31f2d138f81119',
  implementationDigest: 'faac1ad462664fd5b484399ae224e90c180615f9cce5f1432a3dcc4583e1165e',
});
export const PINNED_WRITEBACK_CONTRACT_DIGEST = PINNED_REVIEWED_WRITEBACK_CONTRACT.fileDigest;

export const REVIEWED_WRITEBACK_CONTRACTS = Object.freeze([
  LEGACY_REVIEWED_WRITEBACK_CONTRACT, PINNED_REVIEWED_WRITEBACK_CONTRACT,
] as const);

const contractFiles = new Map<ReviewedWritebackContract['contractVersion'], Buffer>([
  [LEGACY_REVIEWED_WRITEBACK_CONTRACT.contractVersion,
    readFileSync(new URL('./contracts/motive-writeback-local-017.json', import.meta.url))],
  [PINNED_REVIEWED_WRITEBACK_CONTRACT.contractVersion,
    readFileSync(new URL('./contracts/motive-writeback-channel-017.json', import.meta.url))],
]);
for (const contract of REVIEWED_WRITEBACK_CONTRACTS) {
  const bytes = contractFiles.get(contract.contractVersion)!;
  const digest = `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
  if (digest !== contract.fileDigest) throw new Error(`Bundled Hypothesis ${contract.contractVersion} contract digest is invalid.`);
}

export function registeredReviewedWritebackContract(value: unknown): ReviewedWritebackContract | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const candidate = value as Record<string, unknown>;
  return REVIEWED_WRITEBACK_CONTRACTS.find(contract => contract.fileDigest === candidate.fileDigest
    && contract.contractVersion === candidate.contractVersion && contract.apiVersion === candidate.apiVersion
    && contract.schemaRevision === candidate.schemaRevision && contract.surfaceDigest === candidate.surfaceDigest
    && contract.implementationDigest === candidate.implementationDigest) ?? null;
}

export function reviewedWritebackContractForDigest(fileDigest: string): ReviewedWritebackContract | null {
  return REVIEWED_WRITEBACK_CONTRACTS.find(contract => contract.fileDigest === fileDigest) ?? null;
}

export function reviewedWritebackContractBytes(version: ReviewedWritebackContract['contractVersion']): Buffer {
  return Buffer.from(contractFiles.get(version)!);
}

export function pinnedWritebackContractBytes(): Buffer {
  return reviewedWritebackContractBytes(PINNED_REVIEWED_WRITEBACK_CONTRACT.contractVersion);
}
