import { describe, expect, it } from 'vitest';
import { validateAndFreezeProfile, validateRequest } from '../../packages/inference-gateway/src/profile.ts';
import { localGatewayProfile } from '../../scripts/lib/gateway-fixture.ts';

const rawDigest = `sha256:${'7'.repeat(64)}` as const;

function requestPolicy(mode: 'reject' | 'drop-pinned-0.153.4') {
  const fixture = localGatewayProfile('http://127.0.0.1:4545/v1/responses');
  return validateAndFreezeProfile({
    ...fixture,
    requestPolicy: { ...fixture.requestPolicy, codexClientMetadata: mode },
  });
}

function metadata() {
  return {
    root_turn_id: '1'.repeat(36),
    session_id: '2'.repeat(36),
    thread_id: '2'.repeat(36),
    turn_id: '1'.repeat(36),
    'x-codex-installation-id': '3'.repeat(36),
    'x-codex-turn-metadata': JSON.stringify({ request_kind: 'turn', sandbox_mode: 'read-only' }),
    'x-codex-window-id': `${'2'.repeat(36)}:1`,
  };
}

function request(clientMetadata: unknown) {
  return {
    model: 'motive-local-mock-v1', input: 'bounded fixture', stream: true, store: false,
    previous_response_id: null, parallel_tool_calls: true, client_metadata: clientMetadata,
  };
}

describe('pinned Codex client_metadata normalization', () => {
  it('rejects the extension by default', () => {
    expect(() => validateRequest(request(metadata()), requestPolicy('reject'))).toThrow(/unsupported field client_metadata/);
  });

  it('validates and drops only the reviewed 0.153.4 extension while retaining both body digests', () => {
    const input = request(metadata());
    const validated = validateRequest(input, requestPolicy('drop-pinned-0.153.4'), rawDigest);
    expect(validated.rawBodyDigest).toBe(rawDigest);
    expect(validated.normalizedBodyDigest).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(validated.normalizedBodyDigest).not.toBe(rawDigest);
    expect(validated.body).not.toHaveProperty('client_metadata');
    expect(input).toHaveProperty('client_metadata');
    const normalization = validated.normalizations.find(item => item.field === 'client_metadata');
    expect(normalization).toEqual({ field: 'client_metadata', from: 'pinned-codex-0.153.4', to: 'omitted',
      valueDigest: expect.stringMatching(/^sha256:[a-f0-9]{64}$/) });
    expect(JSON.stringify(normalization)).not.toContain('session_id');
    expect(JSON.stringify(normalization)).not.toContain('read-only');
  });

  it('does not require optional pinned keys', () => {
    const validated = validateRequest(request({ session_id: 'a'.repeat(36) }), requestPolicy('drop-pinned-0.153.4'));
    expect(validated.body).not.toHaveProperty('client_metadata');
  });

  it.each([
    [{ ...metadata(), arbitrary: 'value' }, /unsupported field arbitrary/],
    [{ ...metadata(), session_id: 7 }, /session_id must be a non-empty string/],
    [{ ...metadata(), session_id: 'a'.repeat(129) }, /session_id exceeds the pinned Codex bound/],
    [{ ...metadata(), 'x-codex-turn-metadata': 'a'.repeat(2_049) }, /turn-metadata exceeds the pinned Codex bound/],
  ])('rejects unreviewed or unbounded metadata %#', (value, expected) => {
    expect(() => validateRequest(request(value), requestPolicy('drop-pinned-0.153.4'))).toThrow(expected);
  });

  it('binds the normalization policy into the profile digest', async () => {
    const { profileDigest } = await import('../../packages/inference-gateway/src/profile.ts');
    expect(profileDigest(requestPolicy('reject'))).not.toBe(profileDigest(requestPolicy('drop-pinned-0.153.4')));
  });

  it('canonicalizes an omitted profile policy to explicit reject', async () => {
    const { profileDigest } = await import('../../packages/inference-gateway/src/profile.ts');
    const fixture = localGatewayProfile('http://127.0.0.1:4545/v1/responses');
    const { codexClientMetadata: _omitted, ...legacyRequestPolicy } = fixture.requestPolicy;
    const normalized = validateAndFreezeProfile({ ...fixture, requestPolicy: legacyRequestPolicy });
    expect(normalized.requestPolicy.codexClientMetadata).toBe('reject');
    expect(profileDigest(normalized)).toBe(profileDigest(requestPolicy('reject')));
  });
});
