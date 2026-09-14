import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import express from 'express';
import { describe, expect, it } from 'vitest';
import type { DeclareAssignmentIntentInput, SubmitCircleWitnessInput } from '../../src/lib/participation.ts';
import { createParticipationRouters } from './router.ts';
import type { ParticipationService } from './service.ts';

const digest = (character: string) => `sha256:${character.repeat(64)}`;

describe('research delivery target request routing', () => {
  it('passes an exact selector on intent and final investigation and rejects an expanded shape', async () => {
    const assignmentId = randomUUID(); const intents: DeclareAssignmentIntentInput[] = [];
    const submissions: SubmitCircleWitnessInput[] = [];
    const context = { tokenId: randomUUID(), actorId: `agent:${randomUUID()}`, ownerActorId: `account:${randomUUID()}`,
      projectId: randomUUID(), expiresAt: new Date(Date.now() + 60_000).toISOString() };
    const service = { authenticateBearer: async () => context,
      declareAssignmentIntent: async (_context: unknown, _id: string, input: DeclareAssignmentIntentInput) => {
        intents.push(input); return { id: assignmentId };
      },
      submitWitness: async (_context: unknown, _id: string, input: SubmitCircleWitnessInput) => {
        submissions.push(input); return { id: randomUUID() };
      } } as unknown as ParticipationService;
    const { agentRouter } = createParticipationRouters({ service, isActorActive: async () => true });
    const app = express(); app.use('/api/agent', agentRouter); const server = app.listen(0); await once(server, 'listening');
    try {
      const address = server.address(); if (!address || typeof address === 'string') throw new Error('Test server did not bind.');
      const base = `http://127.0.0.1:${address.port}/api/agent/assignments/${assignmentId}`;
      const target = { mode: 'APPEND_EXISTING', scopeId: randomUUID(), snapshotId: randomUUID(),
        snapshotDigest: digest('a'), hypothesisId: randomUUID(), observedUpdatedAt: '2026-09-13T00:00:00.000Z' };
      const references = [{ scopeId: target.scopeId, snapshotId: target.snapshotId, snapshotDigest: target.snapshotDigest,
        hypothesisId: target.hypothesisId, observedUpdatedAt: target.observedUpdatedAt, evidenceIds: [] }];
      const post = (path: string, body: unknown) => fetch(`${base}${path}`, { method: 'POST', headers: {
        Authorization: 'Bearer token', 'Content-Type': 'application/json', 'Idempotency-Key': randomUUID() },
      body: JSON.stringify(body) });
      expect((await post('/intent', { leaseEpoch: 1, proposal: 'Test one update.', expectation: 'Retain one result.',
        conditions: ['Use a pinned target.'], researchReferences: references, researchDeliveryTarget: target })).status).toBe(201);
      expect(intents[0]?.researchDeliveryTarget).toEqual(target);
      const investigation = { format: 'motive.investigation.v1', proposal: 'Test one update.', expectation: 'Retain one result.',
        conditions: ['Use a pinned target.'], observations: ['The test completed.'], assessment: 'Bounded result.',
        nextAction: 'Retain it.', researchReferences: references, researchDeliveryTarget: target };
      expect((await post('/submissions', { leaseEpoch: 1, witness: '{}', investigation })).status).toBe(201);
      expect(submissions[0]?.investigation?.researchDeliveryTarget).toEqual(target);
      const invalid = await post('/intent', { leaseEpoch: 1, proposal: 'Test.', expectation: 'Result.', conditions: ['Pinned.'],
        researchReferences: references, researchDeliveryTarget: { ...target, channelId: randomUUID() } });
      expect(invalid.status).toBe(400);
      expect(intents).toHaveLength(1);
    } finally { server.close(); await once(server, 'close'); }
  });
});
