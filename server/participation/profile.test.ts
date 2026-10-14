import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { EXOPLANET_HUNTING_PARTICIPATION_PROFILE } from './profile.ts';

const sha256 = (value: Buffer) => createHash('sha256').update(value).digest('hex');

describe('exoplanet work-order evidence identity', () => {
  it('pins the exact public pilot plan and checker bytes used for every accepted claim', async () => {
    const [plan, checker, example] = await Promise.all([
      readFile('public/projects/exoplanet-hunting/research-plan.json'),
      readFile('src/lib/exoplanet.ts'),
      readFile('public/projects/exoplanet-hunting/example-evidence.json', 'utf8'),
    ]);
    const profile = EXOPLANET_HUNTING_PARTICIPATION_PROFILE;
    expect(profile.referenceCommit).toBe(sha256(plan));
    expect(profile.referenceWitnessDigest).toBe(`sha256:${sha256(plan)}`);
    expect(profile.checker.sourceDigest).toBe(`sha256:${sha256(checker)}`);
    expect(profile.evaluationProfile).toMatchObject({ protocolDigest: `sha256:${sha256(plan)}`,
      sourceDigest: `sha256:${sha256(checker)}`, scope: 'structure-only',
      provenanceStatus: 'DECLARED_NOT_VERIFIED', scientificStatus: 'NOT_VALIDATED' });
    expect(profile.check(example)).toMatchObject({ ok: true, exactScore: null, exceedsReference: null });
  });
});
