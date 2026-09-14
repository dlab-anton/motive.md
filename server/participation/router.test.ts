import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import express from 'express';
import type { Pool } from 'pg';
import { describe, expect, it } from 'vitest';
import type { DeclareAssignmentIntentInput, SubmitCircleWitnessInput } from '../../src/lib/participation.ts';
import { createParticipationRouters } from './router.ts';
import { createParticipationService, type ParticipationService } from './service.ts';

describe('participation research-context request validation', () => {
  it('routes an exact bounded claim intent and rejects non-text conditions without echoing content', async () => {
    const assignmentId = randomUUID(); const inputs: DeclareAssignmentIntentInput[] = [];
    const context = { tokenId: randomUUID(), actorId: `agent:${randomUUID()}`, ownerActorId: `account:${randomUUID()}`,
      projectId: randomUUID(), expiresAt: new Date(Date.now() + 60_000).toISOString() };
    const service = { authenticateBearer: async () => context,
      declareAssignmentIntent: async (_agent: unknown, _id: string, input: DeclareAssignmentIntentInput) => {
        inputs.push(input); return { id: assignmentId, intent: { ...input, claimId: randomUUID(), workOrderRevision: 1,
          termsDigest: `sha256:${'a'.repeat(64)}`, declaredAt: new Date().toISOString() } };
      } } as unknown as ParticipationService;
    const { agentRouter } = createParticipationRouters({ service, isActorActive: async () => true });
    const app = express(); app.use('/api/agent', agentRouter); const server = app.listen(0); await once(server, 'listening');
    try {
      const address = server.address(); if (!address || typeof address === 'string') throw new Error('Test server did not bind.');
      const url = `http://127.0.0.1:${address.port}/api/agent/assignments/${assignmentId}/intent`;
      const request = (body: unknown) => fetch(url, { method: 'POST', headers: { Authorization: 'Bearer token',
        'Content-Type': 'application/json', 'Idempotency-Key': randomUUID() }, body: JSON.stringify(body) });
      expect((await request({ leaseEpoch: 1, proposal: 'Try a bounded move.', expectation: 'The score increases.',
        conditions: ['Use the current baseline.'] })).status).toBe(201);
      expect(inputs).toEqual([{ leaseEpoch: 1, proposal: 'Try a bounded move.', expectation: 'The score increases.',
        conditions: ['Use the current baseline.'] }]);
      const invalid = await request({ leaseEpoch: 1, proposal: 'Try.', expectation: 'Change.',
        conditions: [{ secret: 'do-not-echo' }] });
      expect(invalid.status).toBe(400); const body = await invalid.json() as { message: string };
      expect(body.message).toBe('intent.conditions[0] must be text.'); expect(body.message).not.toContain('do-not-echo');
    } finally { server.close(); await once(server, 'close'); }
  });

  it('accepts only the exact canonical retained-snapshot identity', async () => {
    const projectId = randomUUID(); const assignmentId = randomUUID(); const inputs: SubmitCircleWitnessInput[] = [];
    const context = { tokenId: randomUUID(), actorId: `agent:${randomUUID()}`, ownerActorId: `account:${randomUUID()}`,
      projectId, expiresAt: new Date(Date.now() + 60_000).toISOString() };
    const service = { authenticateBearer: async () => context,
      submitWitness: async (_agent: unknown, _assignmentId: string, input: SubmitCircleWitnessInput) => {
        inputs.push(input); return { id: randomUUID() };
      } } as unknown as ParticipationService;
    const { agentRouter } = createParticipationRouters({ service, isActorActive: async () => true });
    const app = express(); app.use('/api/agent', agentRouter); const server = app.listen(0); await once(server, 'listening');
    try {
      const address = server.address(); if (!address || typeof address === 'string') throw new Error('Test server did not bind.');
      const url = `http://127.0.0.1:${address.port}/api/agent/assignments/${assignmentId}/submissions`;
      const snapshot = { scopeId: randomUUID(), snapshotId: randomUUID(), snapshotDigest: `sha256:${'a'.repeat(64)}` };
      const investigation = { format: 'motive.investigation.v1', proposal: 'Try one move.', expectation: 'The score changes.',
        conditions: ['Use the exact checker.'], observations: ['The checker ran.'], assessment: 'The move failed.',
        nextAction: 'Try another move.', researchContext: snapshot };
      const request = (researchContext: unknown) => fetch(url, { method: 'POST', headers: { Authorization: 'Bearer token',
        'Content-Type': 'application/json', 'Idempotency-Key': randomUUID() }, body: JSON.stringify({ leaseEpoch: 1, witness: '{}',
        investigation: { ...investigation, researchContext } }) });
      expect((await request(snapshot)).status).toBe(201);
      expect(inputs).toHaveLength(1); expect(inputs[0]?.investigation?.researchContext).toEqual(snapshot);
      for (const invalid of [
        { ...snapshot, extra: true },
        { ...snapshot, scopeId: snapshot.scopeId.toUpperCase() },
        { ...snapshot, snapshotId: randomUUID().replaceAll('-', '') },
        { ...snapshot, snapshotDigest: `sha256:${'A'.repeat(64)}` },
      ]) expect((await request(invalid)).status).toBe(400);
      expect(inputs).toHaveLength(1);
    } finally { server.close(); await once(server, 'close'); }
  });

  it('returns a field-specific error for a non-text investigation item without echoing it', async () => {
    const assignmentId = randomUUID(); const context = { tokenId: randomUUID(), actorId: `agent:${randomUUID()}`,
      ownerActorId: `account:${randomUUID()}`, projectId: randomUUID(), expiresAt: new Date(Date.now() + 60_000).toISOString() };
    const service = { authenticateBearer: async () => context,
      submitWitness: async () => { throw new Error('submission must not be called'); } } as unknown as ParticipationService;
    const { agentRouter } = createParticipationRouters({ service, isActorActive: async () => true });
    const app = express(); app.use('/api/agent', agentRouter); const server = app.listen(0); await once(server, 'listening');
    try {
      const address = server.address(); if (!address || typeof address === 'string') throw new Error('Test server did not bind.');
      const response = await fetch(`http://127.0.0.1:${address.port}/api/agent/assignments/${assignmentId}/submissions`, {
        method: 'POST', headers: { Authorization: 'Bearer token', 'Content-Type': 'application/json', 'Idempotency-Key': randomUUID() },
        body: JSON.stringify({ leaseEpoch: 1, witness: '{}', investigation: { format: 'motive.investigation.v1',
          proposal: 'Try one move.', expectation: 'The score changes.', conditions: [{ private: 'do-not-echo' }],
          observations: ['The checker ran.'], assessment: 'The move failed.', nextAction: 'Try another move.' } }),
      });
      expect(response.status).toBe(400);
      const body = await response.json() as { message: string };
      expect(body.message).toBe('investigation.conditions[0] must be text.');
      expect(body.message).not.toContain('do-not-echo');
    } finally { server.close(); await once(server, 'close'); }
  });

  it('returns the real protocol validator path before opening a database transaction', async () => {
    const context = { tokenId: randomUUID(), actorId: `agent:${randomUUID()}`, ownerActorId: `account:${randomUUID()}`,
      projectId: randomUUID(), expiresAt: new Date(Date.now() + 60_000).toISOString() };
    const service=createParticipationService({connect:async()=>{throw new Error('database must not be reached');}} as unknown as Pool,
      {tokenSecret:'protocol-route-test-secret-longer-than-thirty-two-bytes',issuerActorId:`operator:${randomUUID()}`});
    service.authenticateBearer=async()=>context;
    const {agentRouter}=createParticipationRouters({service,isActorActive:async()=>true});
    const app=express();app.use('/api/agent',agentRouter);const server=app.listen(0);await once(server,'listening');
    try{const address=server.address();if(!address||typeof address==='string')throw new Error('Test server did not bind.');
      const secret='protocol-secret-value-must-not-echo';
      const response=await fetch(`http://127.0.0.1:${address.port}/api/agent/experiment-protocol-matches`,{
        method:'POST',headers:{Authorization:'Bearer token','Content-Type':'application/json'},body:JSON.stringify({
          experimentProtocol:{format:'motive.experiment-protocol.v1',procedure:'bounded-search-v1',purpose:'EXPLORATORY',
            inputs:[{name:'camelCase',value:secret}]}})});
      expect(response.status).toBe(400);const body=await response.json() as {message:string};
      expect(body.message).toBe('Invalid experiment protocol. experimentProtocol.inputs[0].name must start with a lowercase letter and contain only lowercase letters, digits, underscore, dot, or hyphen, with at most 64 characters.');
      expect(body.message).not.toContain(secret);expect(body.message).not.toContain('database must not be reached');
    }finally{server.close();await once(server,'close');}
  });
});
