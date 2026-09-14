import { describe, expect, it } from 'vitest';
import { validateSubmissionReproducibility } from './service.ts';

const digest = `sha256:${'a'.repeat(64)}`;

describe('submission reproducibility validation', () => {
  it('accepts exact UTF-8 byte boundaries', () => {
    expect(validateSubmissionReproducibility({ reportDigest: digest, solverSource: 's'.repeat(16 * 1024),
      trialResults: 't'.repeat(32 * 1024) })).toMatchObject({ reportDigest: digest });
  });

  it.each([
    ['solverSource', { solverSource: 's'.repeat(16 * 1024 + 1), trialResults: 'trial' }, 'reproducibility.solverSource must be at most 16384 UTF-8 bytes.'],
    ['trialResults', { solverSource: 'source', trialResults: 't'.repeat(32 * 1024 + 1) }, 'reproducibility.trialResults must be at most 32768 UTF-8 bytes.'],
  ])('rejects the %s byte overflow', (_name, files, message) => {
    expect(() => validateSubmissionReproducibility({ reportDigest: digest, ...files })).toThrow(message);
  });

  it('counts UTF-8 bytes rather than code units', () => {
    expect(() => validateSubmissionReproducibility({ reportDigest: digest,
      solverSource: '\u{1f642}'.repeat(4097), trialResults: 'trial' }))
      .toThrow('reproducibility.solverSource must be at most 16384 UTF-8 bytes.');
  });

  it('rejects unpaired UTF-16 surrogates instead of storing replacement bytes', () => {
    expect(() => validateSubmissionReproducibility({ reportDigest: digest, solverSource: 'source\ud800', trialResults: 'trial' }))
      .toThrow('reproducibility.solverSource contains invalid Unicode and cannot be encoded losslessly as UTF-8.');
    expect(() => validateSubmissionReproducibility({ reportDigest: digest, solverSource: 'source', trialResults: '\udc00trial' }))
      .toThrow('reproducibility.trialResults contains invalid Unicode and cannot be encoded losslessly as UTF-8.');
  });

  it('requires two nonempty fixed text files and exact keys', () => {
    expect(() => validateSubmissionReproducibility({ reportDigest: digest, solverSource: '', trialResults: 'trial' }))
      .toThrow('reproducibility.solverSource must be a nonempty UTF-8 text file.');
    expect(() => validateSubmissionReproducibility({ reportDigest: digest, solverSource: 'source', trialResults: '', extra: true } as never))
      .toThrow('Reproducibility body must contain exactly reportDigest, solverSource, and trialResults.');
  });
});
