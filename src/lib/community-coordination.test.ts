import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  isCommunityCoordinationPlanInput,
  isCompleteCommunityCoordinationTurnInput,
  isCreateCommunityCoordinationGrantInput,
  isReleaseCommunityCoordinationTurnInput,
} from './community-coordination.ts';

const digest = (character: string) => `sha256:${character.repeat(64)}`;

function priority(suffix = '') {
  return { kind: 'EXPERIMENT' as const, question: `Can this bounded branch improve?${suffix}`,
    expectation: 'The exact score may improve.', test: 'Run a finite batch and retain every outcome.',
    positiveInterpretation: 'Prioritize the validated branch.', negativeInterpretation: 'Retain the counterexample and change branches.',
    inconclusiveInterpretation: 'Record the limitation before another bounded test.',
    motiveReferences: [{ submissionId: randomUUID(), reportDigest: digest('a'), artifactDigest: digest('b') }] };
}

function plan() {
  return { format: 'motive.community-coordination-plan.v1' as const, summary: 'One evidence-linked bounded branch.',
    limitations: 'This advice is unreviewed and does not authorize work.', priorities: [priority(' 🧪')] };
}

describe('community coordination contracts', () => {
  it('accepts the exact bounded plan and endpoint envelopes', () => {
    const grantId = randomUUID();
    expect(isCommunityCoordinationPlanInput(plan())).toBe(true);
    expect(isCreateCommunityCoordinationGrantInput({ agentTokenId: randomUUID(), maxTurns: 5 })).toBe(true);
    expect(isReleaseCommunityCoordinationTurnInput({ grantId, turnId: randomUUID(), reason: 'Yield to another volunteer.' })).toBe(true);
    expect(isCompleteCommunityCoordinationTurnInput({ grantId, turnId: randomUUID(), plan: plan() })).toBe(true);
  });

  it('rejects surplus keys, invalid limits, duplicate references, and unpaired UTF-16 while allowing emoji', () => {
    expect(isCreateCommunityCoordinationGrantInput({ agentTokenId: randomUUID(), maxTurns: 6 })).toBe(false);
    expect(isCommunityCoordinationPlanInput({ ...plan(), injected: true })).toBe(false);
    const duplicate = priority(); duplicate.motiveReferences.push({ ...duplicate.motiveReferences[0]! });
    expect(isCommunityCoordinationPlanInput({ ...plan(), priorities: [duplicate] })).toBe(false);
    expect(isCommunityCoordinationPlanInput({ ...plan(), summary: '\ud800' })).toBe(false);
    expect(isCommunityCoordinationPlanInput({ ...plan(), summary: 'Useful 🧪 advice.' })).toBe(true);
  });

  it('enforces the 16 KiB UTF-8 plan envelope and at most three priorities', () => {
    expect(isCommunityCoordinationPlanInput({ ...plan(), priorities: [priority('1'), priority('2'), priority('3'), priority('4')] })).toBe(false);
    const large = { ...plan(), summary: '測'.repeat(1_000), limitations: 'ß'.repeat(1_000), priorities: [0,1,2].map(index => ({
      ...priority(String(index)), question: 'q'.repeat(500), expectation: 'e'.repeat(500), test: 't'.repeat(1_000),
      positiveInterpretation: 'p'.repeat(500), negativeInterpretation: 'n'.repeat(500), inconclusiveInterpretation: 'i'.repeat(500),
      motiveReferences: Array.from({ length: 3 }, (_, reference) => ({ submissionId: randomUUID(),
        reportDigest: digest(String((index+reference)%10)), artifactDigest: digest(String((index+reference+1)%10)) })) })) };
    expect(new TextEncoder().encode(JSON.stringify(large)).byteLength).toBeGreaterThan(16_384);
    expect(isCommunityCoordinationPlanInput(large)).toBe(false);
  });
});
