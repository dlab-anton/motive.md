import { createHash } from 'node:crypto';
import type { ImmutableObjectStore } from '../../artifact-storage/src/types.ts';
import type { Digest } from '../../domain/src/contracts.ts';
import { MAX_RAW_COMPARATOR_REPORT_BYTES, type TrustedComparatorReportCapture } from '../../evaluator-lean/src/contract.ts';

function key(environmentId: string): string {
  if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(environmentId)) throw new Error('EVALUATOR_ID_INVALID');
  return `evaluations/${environmentId}/report.json`;
}
const digest = (bytes: Uint8Array): Digest => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;

/** Uses the existing immutable artifact store. Raw reports survive VM teardown and DB-response loss. */
export class DurableEvaluatorReports {
  constructor(private readonly objects: ImmutableObjectStore) {}

  async read(environmentId: string): Promise<TrustedComparatorReportCapture | null> {
    const found = await this.objects.readObject({ objectKey: key(environmentId), maximumBytes: MAX_RAW_COMPARATOR_REPORT_BYTES,
      maximumChunkBytes: 65536, signal: AbortSignal.timeout(15000) });
    if (!found) return null;
    if (found.declaredBytes !== null && (found.declaredBytes < 1 || found.declaredBytes > MAX_RAW_COMPARATOR_REPORT_BYTES)) {
      throw new Error('EVALUATOR_REPORT_SIZE_INVALID');
    }
    const chunks: Uint8Array[] = [];
    let size = 0;
    for await (const chunk of found.body) {
      size += chunk.byteLength;
      if (size > MAX_RAW_COMPARATOR_REPORT_BYTES) throw new Error('EVALUATOR_REPORT_SIZE_INVALID');
      chunks.push(Uint8Array.from(chunk));
    }
    if (!size || (found.declaredBytes !== null && found.declaredBytes !== size)) throw new Error('EVALUATOR_REPORT_SIZE_INVALID');
    const bytes = Buffer.concat(chunks);
    return { bytes, expected_raw_report_digest: digest(bytes) };
  }

  async retain(environmentId: string, capture: TrustedComparatorReportCapture): Promise<TrustedComparatorReportCapture> {
    const bytes = Uint8Array.from(capture.bytes);
    if (!bytes.length || bytes.length > MAX_RAW_COMPARATOR_REPORT_BYTES || digest(bytes) !== capture.expected_raw_report_digest) {
      throw new Error('EVALUATOR_REPORT_DIGEST_INVALID');
    }
    await this.objects.putIfAbsent({ objectKey: key(environmentId), body: (async function* () { yield bytes; })(),
      contentType: 'application/json', expectedBytes: bytes.length, expectedDigest: capture.expected_raw_report_digest,
      signal: AbortSignal.timeout(15000) });
    const retained = await this.read(environmentId);
    if (!retained || retained.expected_raw_report_digest !== capture.expected_raw_report_digest) throw new Error('EVALUATOR_REPORT_CONFLICT');
    return retained;
  }
}
