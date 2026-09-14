import type { ImmutableObjectStore } from '../../artifact-storage/src/types.ts';
import type { Digest } from '../../domain/src/contracts.ts';
import type { TrustedCircleEvaluatorReportCapture } from './contract.ts';
import { evaluateCheckedCircleCandidate } from './evaluator.ts';
import {
  SealedCircleCandidateReader,
  type ReadSealedCircleCandidateInput,
  type TrustedCircleSealContextResolver,
} from './sealed-reader.ts';

export type EvaluateSealedCirclePackingInput = ReadSealedCircleCandidateInput & {
  workOrderTerms: unknown;
  evaluationProfile: unknown;
  evaluationProfileDigest: Digest;
};

/**
 * End-to-end data-only evaluator adapter. Trusted application composition
 * supplies the immutable store and controller-derived context resolver.
 */
export class SealedCirclePackingEvaluator {
  private readonly reader: SealedCircleCandidateReader;

  constructor(dependencies: {
    store: Pick<ImmutableObjectStore, 'readObject'>;
    contextResolver: TrustedCircleSealContextResolver;
  }) {
    this.reader = new SealedCircleCandidateReader(dependencies);
  }

  async evaluate(input: EvaluateSealedCirclePackingInput): Promise<TrustedCircleEvaluatorReportCapture> {
    const candidate = await this.reader.read(input);
    return evaluateCheckedCircleCandidate({ candidate, workOrderTerms: input.workOrderTerms,
      evaluationProfile: input.evaluationProfile, evaluationProfileDigest: input.evaluationProfileDigest });
  }
}
