import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { applyPostgresMigrations, getPostgresSchemaStatus } from '../../packages/accounting/src/migrations.ts';
import { LedgerKernel } from '../../packages/accounting/src/kernel.ts';
import { encryptSecret } from '../../server/funding/vault.ts';
import {
  createParticipationService,
  type ParticipationAgentContext,
  type ParticipationService,
} from '../../server/participation/index.ts';
import {
  createHypothesisSubmissionAdmissionService,
  createHypothesisSubmissionDeliveryService,
} from '../../server/research-memory/index.ts';
import {
  PINNED_WRITEBACK_CONTRACT_DIGEST,
} from '../../server/research-memory/pinned-writeback-contract.ts';
import { createCommandAccountActivityResolver } from '../../scripts/lib/operator-account.ts';
import { syncProjectResearch, type SyncProjectResearchArguments } from '../../scripts/sync-project-research.ts';

const baseUrl = process.env.MOTIVE_TEST_DATABASE_URL;
const pgDescribe = baseUrl ? describe : describe.skip;
const apiBase = 'https://engine.invalid/api/v1';
const apiKey = `he_${'k'.repeat(43)}`;
const vaultKey = Buffer.alloc(32, 31);
const contractFile = resolve('server/research-memory/contracts/motive-writeback-channel-017.json');

function engineMock() {
  const requests: Array<{ path: string; key: string }> = [];
  const committed = new Map<string, Record<string, unknown>>();
  const now = '2026-09-09T00:00:00.000Z';
  const fetcher: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    const headers = new Headers(init?.headers);
    expect(headers.get('X-API-Key')).toBe(apiKey);
    const key = headers.get('Idempotency-Key')!;
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    requests.push({ path: url.pathname, key });
    const prior = committed.get(key);
    if (prior) return new Response(JSON.stringify(prior), { status: 201, headers: { 'content-type': 'application/json' } });
    let response: Record<string, unknown>;
    if (url.pathname.endsWith('/hypotheses')) {
      response = {
        id: randomUUID(), statement: body.statement, context: body.context, falsification_criteria: null,
        status: 'draft', confidence: null, initial_confidence: null, tags: [], created_by: body.created_by,
        parent_id: null, is_archived: false, evidence_counts: { supporting: 0, contradicting: 0, neutral: 0 },
        deadline: null, metadata: body.metadata, null_hypothesis: null, experimental_design: body.experimental_design,
        significance_level: null, outcome: null, channel: body.channel, created_at: now, updated_at: now,
      };
    } else {
      const target = /\/hypotheses\/([a-f0-9-]+)\/evidence$/.exec(url.pathname)?.[1];
      if (!target) throw new Error('Unexpected evidence path.');
      const hypothesis = [...committed.values()].find(item => item.id === target);
      if (!hypothesis) throw new Error('Draft hypothesis was not committed.');
      response = {
        evidence: { id: randomUUID(), hypothesis_id: target, content: body.content, source: body.source,
          evidence_type: 'neutral', strength: null, confidence_after: null, created_by: body.created_by, created_at: now },
        hypothesis: { ...hypothesis, evidence_counts: { supporting: 0, contradicting: 0, neutral: 1 }, updated_at: now },
      };
    }
    committed.set(key, response);
    return new Response(JSON.stringify(response), { status: 201, headers: { 'content-type': 'application/json' } });
  };
  return { fetcher, requests };
}

pgDescribe('sync-project-research account authority integration', () => {
  const databaseName = `motive_sync_cli_${randomUUID().replaceAll('-', '')}`;
  const operator = `operator:${randomUUID()}`;
  const ownerSubject = randomUUID();
  const reviewerSubject = randomUUID();
  const contributorSubject = randomUUID();
  const owner = `account:${ownerSubject}`;
  const reviewer = `account:${reviewerSubject}`;
  const contributor = `account:${contributorSubject}`;
  const activeSubjects = new Set<string>([ownerSubject, reviewerSubject, contributorSubject]);
  const remoteChecks: string[] = [];
  const remote = { isActive: vi.fn(async (subjectId: string) => {
    remoteChecks.push(subjectId);
    return activeSubjects.has(subjectId);
  }) };
  const environment = {
    MOTIVE_ACCOUNT_PROVIDER: 'supabase',
    SUPABASE_URL: 'https://accounts.example.test',
    SUPABASE_PUBLISHABLE_KEY: `sb_publishable_${'p'.repeat(24)}`,
    SUPABASE_SECRET_KEY: `sb_secret_${'s'.repeat(24)}`,
    MOTIVE_AGENT_TOKEN_SECRET: `agent-${'t'.repeat(48)}`,
    MOTIVE_FUNDING_VAULT_KEY: vaultKey.toString('base64url'),
  } as const;
  let admin: Pool;
  let pool: Pool;
  let participation: ParticipationService;
  let contributorContext: ParticipationAgentContext;
  let projectId: string;
  let scopeId: string;
  let workOrderId: string;
  let referenceWitness: string;

  beforeAll(async () => {
    const source = new URL(baseUrl!);
    if (!['localhost', '127.0.0.1', '[::1]'].includes(source.hostname)) {
      throw new Error('LOCAL_TEST_DATABASE_REQUIRED');
    }
    const adminUrl = new URL(source); adminUrl.pathname = '/postgres';
    admin = new Pool({ connectionString: adminUrl.toString(), max: 1 });
    await admin.query(`CREATE DATABASE ${databaseName}`);
    const testUrl = new URL(source); testUrl.pathname = `/${databaseName}`;
    pool = new Pool({ connectionString: testUrl.toString(), max: 2 });
    await applyPostgresMigrations(pool);
    expect((await getPostgresSchemaStatus(pool)).exact).toBe(true);
    const project = await new LedgerKernel(pool).createProject({ actorId: operator, idempotencyKey: randomUUID(),
      slug: 'circle-packing', visibility: 'PUBLIC', revisionContent: { title: 'CLI authority integration' } });
    projectId = project.id;
    await pool.query(`INSERT INTO motive.account_identities(actor_id,provider,subject_id,status,created_at) VALUES
      ($1,'supabase',$2,'ACTIVE',clock_timestamp()),($3,'supabase',$4,'ACTIVE',clock_timestamp()),
      ($5,'supabase',$6,'ACTIVE',clock_timestamp())`,
    [owner, ownerSubject, reviewer, reviewerSubject, contributor, contributorSubject]);
    await pool.query(`INSERT INTO motive.memberships(id,project_id,actor_id,role,scopes,granted_by) VALUES
      ($1,$2,$3,'OWNER',ARRAY['project:admin'],$3),($4,$2,$5,'REVIEWER',ARRAY[]::text[],$3)`,
    [randomUUID(), projectId, owner, randomUUID(), reviewer]);
    participation = createParticipationService(pool, { tokenSecret: environment.MOTIVE_AGENT_TOKEN_SECRET,
      issuerActorId: operator });
    workOrderId = (await participation.ensureCircleWorkOrder()).id;
    const joined = await participation.join(contributor, 'Departable contributor', {
      projectSlug: 'circle-packing', publishDisplayName: true, acceptReferenceTerms: true,
    }, `join-${randomUUID()}`);
    contributorContext = await participation.authenticateBearer(joined.token);
    await participation.claimAssignment(contributorContext, workOrderId, `claim-${randomUUID()}`);
    referenceWitness = await readFile('public/projects/circle-packing/reference-witness.json', 'utf8');
    scopeId = randomUUID();
    const encrypted = encryptSecret(vaultKey, apiKey, `research-scope:v1:${scopeId}:${projectId}`);
    await pool.query(`INSERT INTO motive.project_research_scopes(id,project_id,provider,api_base_url,tenant_id,channel_id,
      channel_name,channel_snapshot,channel_snapshot_digest,encrypted_api_key,credential_fingerprint,configuration_digest,
      api_version,inspected_source_revision,status,bound_by,verified_at)
      VALUES($1,$2,'hypothesis-engine',$3,$4,$5,'circle-packing','{}'::jsonb,$6,$7,$8,$9,'1.8.0',$10,'CONNECTED',$11,clock_timestamp())`,
    [scopeId, projectId, apiBase, randomUUID(), randomUUID(), `sha256:${'a'.repeat(64)}`, encrypted,
      `sha256:${'b'.repeat(64)}`, `sha256:${'c'.repeat(64)}`, '7'.repeat(40), owner]);
  }, 30_000);

  afterAll(async () => {
    await pool?.end();
    if (admin) {
      await admin.query('SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=$1 AND pid<>pg_backend_pid()', [databaseName]);
      await admin.query(`DROP DATABASE IF EXISTS ${databaseName}`);
      await admin.end();
    }
  });

  async function submission() {
    const result = await participation.submitWitness(contributorContext, workOrderId, {
      leaseEpoch: 1,
      witness: referenceWitness,
      investigation: {
        format: 'motive.investigation.v1', proposal: 'Retain this checked construction as a bounded draft proposal.',
        expectation: 'The protected checker determines the result.', conditions: ['Use the exact protected checker.'],
        observations: ['A submission was made.'], assessment: 'The report remains separate evidence.',
        nextAction: 'Review the bounded result independently.',
      },
    }, `submit-${randomUUID()}`);
    const artifact = await pool.query('SELECT report_digest FROM motive.participation_submission_artifacts WHERE submission_id=$1', [result.id]);
    await participation.createPostCheckAssessment(contributorContext, result.id, {
      reportDigest: artifact.rows[0].report_digest,
      assessment: 'The protected checker report is retained without a support conclusion.',
      nextAction: 'Review this exact package independently.',
    }, `post-${randomUUID()}`);
    return result.id;
  }

  function commandArguments(submissionId: string): SyncProjectResearchArguments {
    return { selector: { accountId: ownerSubject }, project: 'circle-packing', scopeId, submissionId,
      idempotencyKey: `cli-${randomUUID()}`, approvedApiBaseUrl: apiBase, contractFile,
      contractDigest: PINNED_WRITEBACK_CONTRACT_DIGEST, execute: true };
  }

  async function admit(submissionId: string) {
    const configuration = {
      provider: 'supabase' as const,
      public: { provider: 'supabase' as const, supabaseUrl: environment.SUPABASE_URL,
        supabasePublishableKey: environment.SUPABASE_PUBLISHABLE_KEY },
      supabase: { url: environment.SUPABASE_URL, publishableKey: environment.SUPABASE_PUBLISHABLE_KEY,
        secretKey: environment.SUPABASE_SECRET_KEY },
      agentTokenSecret: environment.MOTIVE_AGENT_TOKEN_SECRET,
    };
    const activity = await createCommandAccountActivityResolver({ pool, configuration, remote });
    try {
      const sender = createHypothesisSubmissionDeliveryService({ pool, vaultKey,
        isActorActive: activity.isActorActive, fetch: async () => { throw new Error('Preview must not call the engine.'); } });
      const admission = createHypothesisSubmissionAdmissionService({ pool, vaultKey,
        isActorActive: activity.isActorActive, sender });
      const preview = await admission.prepareAdmissionPreview(reviewer, submissionId);
      await admission.decideAdmission(reviewer, submissionId, { packageDigest: preview.packageDigest,
        expectedDecisionId: preview.latestDecision?.id ?? null, decision: 'ADMIT',
        rationale: 'Independent review admits this exact checked record as neutral context only.' }, `admit-${randomUUID()}`);
    } finally { activity.close(); }
  }

  it('resolves the distinct operator, reviewer, and contributor and denies delivery after current revocation', async () => {
    const first = await submission();
    await admit(first);
    const engine = engineMock();
    const result = await syncProjectResearch({ pool, arguments: commandArguments(first), env: environment,
      remote, fetch: engine.fetcher });
    expect(result.status).toBe('EVIDENCE_RECORDED');
    expect(engine.requests).toHaveLength(2);
    expect(new Set(remoteChecks)).toEqual(new Set([ownerSubject, reviewerSubject, contributorSubject]));

    const second = await submission();
    await admit(second);
    activeSubjects.delete(reviewerSubject);
    const before = engine.requests.length;
    await expect(syncProjectResearch({ pool, arguments: commandArguments(second), env: environment,
      remote, fetch: engine.fetcher })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(engine.requests).toHaveLength(before);

    activeSubjects.add(reviewerSubject);
    const third = await submission();
    await admit(third);
    await pool.query('UPDATE motive.participation_agent_tokens SET revoked_at=clock_timestamp() WHERE id=$1',
      [contributorContext.tokenId]);
    await expect(syncProjectResearch({ pool, arguments: commandArguments(third), env: environment,
      remote, fetch: engine.fetcher })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(engine.requests).toHaveLength(before);
  }, 30_000);
});
