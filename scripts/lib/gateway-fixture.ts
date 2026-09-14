import { randomUUID } from 'node:crypto';
import type { LedgerKernel } from '../../packages/accounting/src/kernel.ts';
import { profileDigest, validateAndFreezeProfile } from '../../packages/inference-gateway/src/profile.ts';

/** Local synthetic evidence only. Never use this as a live execution profile. */
export function localGatewayProfile(responsesUrl: string) {
  return validateAndFreezeProfile({
    format: 'motive.gateway-profile/0.1', profileId: 'gateway-local-codex-0.153.4-r1', status: 'test-only-local-mock',
    upstream: { responsesUrl, credentialRef: 'fixture:gateway-test' },
    route: { model: 'motive-local-mock-v1', provider: null },
    limits: { maxRequestBytes: 262144, maxResponseBytes: 1048576, maxEventBytes: 262144,
      requestTimeoutMs: 5000, maxInputItems: 128, maxTools: 4, contextWindowTokens: 4096, maxOutputTokens: 256 },
    requestPolicy: {
      allowedLocalTools: ['exec_command', 'write_stdin', 'request_user_input', 'view_image'].map(name => ({ type: 'function', name })),
      // Codex's ordinary Responses wire format advertises parallel local tools.
      // These are free local functions; multi-agent features remain disabled and
      // the ledger still permits only one inference request in flight per attempt.
      allowedReasoningEfforts: ['low'], allowParallelToolCalls: true, allowTemperature: false, allowTopP: false,
      codexClientMetadata: 'drop-pinned-0.153.4',
    },
    pricing: { currency: 'USD', highestInputUsdPerMillionTokens: '1.000000000000',
      highestOutputUsdPerMillionTokens: '2.000000000000', fixedRequestUsd: '0.010000000000',
      worstCaseAdditionalUsd: '0.020000000000', approvedMaximumExposureUsd: '0.034608000000' },
    evidence: { kind: 'local-mock', reviewedAt: '2026-09-06', reviewedBy: 'gateway-protocol-test',
      pricingSource: 'fixture:synthetic-not-live',
      responsesCompatibilitySource: 'fixture:codex-0.153.4-regular-responses-client-metadata-drop-r1' },
  });
}

export async function seedGatewayAttempt(ledger: LedgerKernel, profile: ReturnType<typeof localGatewayProfile>) {
  const actorId = `gateway-fixture:${randomUUID()}`;
  const project = await ledger.createProject({ actorId, idempotencyKey: randomUUID(), slug: `gateway-${randomUUID()}`,
    visibility: 'PRIVATE', revisionContent: { title: 'Synthetic gateway fixture', purpose: 'Local infrastructure verification' } });
  const source = await ledger.createFundingSource({ actorId, idempotencyKey: randomUUID(), authorizedAmount: '10', metadata: { synthetic: true } });
  const grant = await ledger.createGrant({ actorId, idempotencyKey: randomUUID(), sourceId: source.id, projectId: project.id, limitAmount: '5' });
  const digest = profileDigest(profile);
  const work = await ledger.createWorkOrder({ actorId, idempotencyKey: randomUUID(), projectId: project.id,
    workOrderKey: 'gateway-fixture', revision: 1, state: 'READY', terms: {
      format: 'motive.work-order/0.1', project_id: project.id, project_revision: 1, agreement_id: `fixture-${randomUUID()}`,
      objective: 'Verify gateway accounting against a synthetic local provider.', input_commit: 'd'.repeat(40),
      allowed_effects: ['read-approved-inputs', 'submit-artifact'],
      hosted: { enabled: true, inference: { currency: 'USD', ceiling: '2.000000000000', profile_digest: digest }, maximum_runtime_seconds: 120 },
      external: { enabled: false, claim_required: false, max_active_claims: 1, max_lease_seconds: 120,
        late_submission_policy: 'reject', review_admission: 'manual',
        artifact: { formats: ['motive.patch/0.1'], max_bytes: 1024, license_acceptance_required: true } },
      evaluation: { profile_digest: `sha256:${'b'.repeat(64)}`, human_acceptance_required: true },
    } });
  const attempt = await ledger.reserveAttempt({ actorId, idempotencyKey: randomUUID(), grantId: grant.id, workOrderId: work.id,
    ceilingAmount: '2', profileDigest: digest, inputDigest: `sha256:${'c'.repeat(64)}` });
  const issued = await ledger.issueRunCapability({ actorId, idempotencyKey: randomUUID(), attemptId: attempt.id, ttlSeconds: 120 });
  return { actorId, project, source, grant, attempt, ...issued };
}
