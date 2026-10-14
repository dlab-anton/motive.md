import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import example from '../../public/projects/exoplanet-hunting/example-evidence.json';
import { checkExoplanetEvidence, EXOPLANET_EVIDENCE_FORMAT, EXOPLANET_MAX_BYTES, type ExoplanetEvidence } from './exoplanet';

function fixture(): ExoplanetEvidence {
  return structuredClone(example) as ExoplanetEvidence;
}
function check(value: unknown) { return checkExoplanetEvidence(JSON.stringify(value)); }
function errorCode(value: unknown) {
  const result = check(value);
  return result.ok ? 'ACCEPTED' : result.error.code;
}

describe('exoplanet evidence structural checker', () => {
  it('accepts the explicitly synthetic, inconclusive example without a science score', () => {
    const result = check(fixture());
    expect(result).toEqual({ ok: true, report: {
      format: 'motive.exoplanet.structure-check.v1', scope: 'STRUCTURE_ONLY', scientificStatus: 'NOT_VALIDATED',
      dataKind: 'synthetic', taskKind: 'control-recovery', classification: 'inconclusive',
      inputCount: 1, eventCount: 0, diagnosticCount: 1, controlResultCount: 1, limitationCount: 1, nextStepCount: 1,
    } });
    expect(JSON.stringify(result)).not.toMatch(/score|validat(?:ed|ion).*true/i);
    const placeholderDigest = createHash('sha256').update('synthetic-control-placeholder-v1').digest('hex');
    expect(example.inputs[0].sha256).toBe(placeholderDigest);
  });

  it('accepts a structurally complete observational candidate as an unverified assertion', () => {
    const evidence = fixture();
    evidence.dataKind = 'observational';
    evidence.taskKind = 'replication';
    evidence.inputs[0].uri = 'https://mast.stsci.edu/api/v0.1/Download/file?uri=mast:TESS/product/example.fits';
    evidence.inputs[0].fluxProvenance = 'Author-reported PDCSAP flux from a public product; source bytes are asserted here, not checked.';
    evidence.observations = { classification: 'candidate', events: [
      { epochBjdTdb: 2460000.5, depthPpm: 125, durationHours: 2.4, uncertaintyPpm: 30 },
    ] };
    evidence.orbitalFit = {
      periodDays: 3.5, periodUncertaintyDays: 0.02, epochBjdTdb: 2460000.5,
      epochUncertaintyDays: 0.01, depthPpm: 125, depthUncertaintyPpm: 30,
    };
    evidence.diagnostics.push({ name: 'Centroid', status: 'fail', notes: 'Reported displacement requires review.' });
    evidence.controlResults.push({ name: 'Injection recovery', status: 'inconclusive', notes: 'Insufficient controls.' });
    const result = check(evidence);
    expect(result).toMatchObject({ ok: true, report: { classification: 'candidate', scope: 'STRUCTURE_ONLY', scientificStatus: 'NOT_VALIDATED', eventCount: 1 } });
  });

  it('preserves valid no-signal and inconclusive outcomes with no events or controls', () => {
    for (const classification of ['no-signal', 'inconclusive'] as const) {
      const evidence = fixture();
      evidence.observations.classification = classification;
      evidence.diagnostics = [];
      evidence.controlResults = [];
      expect(check(evidence)).toMatchObject({ ok: true, report: { classification, eventCount: 0, controlResultCount: 0 } });
    }
  });

  it('rejects synthetic candidate and false-positive claims, and empty candidate events', () => {
    for (const classification of ['candidate', 'false-positive'] as const) {
      const evidence = fixture();
      evidence.observations.classification = classification;
      expect(errorCode(evidence)).toBe('INVALID_CLASSIFICATION');
    }
    const observational = fixture();
    observational.dataKind = 'observational';
    observational.inputs[0].uri = 'mast:TESS/product/demo.fits';
    observational.observations.classification = 'candidate';
    expect(errorCode(observational)).toBe('MALFORMED_STRUCTURE');
  });

  it('rejects unknown fields, missing provenance, wrong enums and mismatched synthetic digest', () => {
    const unknown = { ...fixture(), scientificScore: 99 };
    expect(errorCode(unknown)).toBe('MALFORMED_STRUCTURE');
    const absent = fixture() as Partial<ExoplanetEvidence>;
    delete absent.controlResults;
    expect(errorCode(absent)).toBe('MALFORMED_STRUCTURE');
    const wrongProtocol = fixture(); wrongProtocol.protocolVersion = 'motive.exoplanet-hunting.pilot.v2' as ExoplanetEvidence['protocolVersion'];
    expect(errorCode(wrongProtocol)).toBe('WRONG_PROTOCOL');
    const digest = fixture(); digest.inputs[0].sha256 = 'a'.repeat(64);
    expect(errorCode(digest)).toBe('INVALID_URI');
    const unsafe = fixture(); unsafe.inputs[0].uri = 'file:///C:/observations.fits';
    expect(errorCode(unsafe)).toBe('INVALID_URI');
    const command = fixture(); command.method.commands = [];
    expect(errorCode(command)).toBe('MALFORMED_STRUCTURE');
  });

  it('rejects numeric coercion, impossible field signs, nonfinite JSON and duplicate decoded keys', () => {
    const stringNumber = fixture(); stringNumber.inputs[0].sector = '1' as unknown as number;
    expect(errorCode(stringNumber)).toBe('INVALID_FIELD');
    const negativeDuration = fixture(); negativeDuration.observations.events = [
      { epochBjdTdb: 2460000, depthPpm: 100, durationHours: -1 },
    ];
    expect(errorCode(negativeDuration)).toBe('INVALID_FIELD');
    negativeDuration.observations.events[0].durationHours = 2;
    negativeDuration.observations.events[0].epochBjdTdb = -1;
    expect(errorCode(negativeDuration)).toBe('INVALID_FIELD');
    negativeDuration.observations.events[0].epochBjdTdb = 2460000;
    negativeDuration.observations.events[0].depthPpm = 1_000_001;
    expect(errorCode(negativeDuration)).toBe('INVALID_FIELD');
    expect(checkExoplanetEvidence(JSON.stringify(fixture()).replace('"format":', '"\\u0066ormat":"extra","format":')))
      .toMatchObject({ ok: false, error: { code: 'DUPLICATE_KEY' } });
    expect(checkExoplanetEvidence(JSON.stringify(fixture()).replace('"sector":1', '"sector":NaN')))
      .toMatchObject({ ok: false, error: { code: 'MALFORMED_JSON' } });
    expect(checkExoplanetEvidence(JSON.stringify(fixture()).replace('"sector":1', '"sector":1e999')))
      .toMatchObject({ ok: false, error: { code: 'NONFINITE_NUMBER' } });
  });

  it('enforces exact format, UTF-8 byte limit, bounded arrays and JSON depth', () => {
    const evidence = fixture(); evidence.format = 'bad' as typeof EXOPLANET_EVIDENCE_FORMAT;
    expect(errorCode(evidence)).toBe('WRONG_FORMAT');
    expect(checkExoplanetEvidence(' '.repeat(EXOPLANET_MAX_BYTES + 1)))
      .toMatchObject({ ok: false, error: { code: 'SIZE_LIMIT' } });
    const many = fixture(); many.inputs = Array.from({ length: 33 }, () => structuredClone(many.inputs[0]));
    expect(errorCode(many)).toBe('MALFORMED_STRUCTURE');
    expect(checkExoplanetEvidence(`${'['.repeat(17)}null${']'.repeat(17)}`))
      .toMatchObject({ ok: false, error: { code: 'DEPTH_LIMIT' } });
  });
});
