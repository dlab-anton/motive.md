import { createHash,randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe,expect,it } from 'vitest';
import { buildNeutralEvidenceBody,verifyReviewedWritebackContract,
  type Delivery,type DeliverySource } from '../server/research-memory/submission-delivery.ts';
import { LEGACY_REVIEWED_WRITEBACK_CONTRACT,PINNED_REVIEWED_WRITEBACK_CONTRACT,
  reviewedWritebackContractBytes } from '../server/research-memory/pinned-writeback-contract.ts';
import { parseSyncProjectResearchArguments } from './sync-project-research.ts';

const digest=(bytes:Uint8Array)=>`sha256:${createHash('sha256').update(bytes).digest('hex')}`;

describe('reviewed Hypothesis delivery CLI boundary',()=>{
  it('pins only the exact cap2 and cap3 contract bytes and required channel surface',()=>{
    for(const contract of [LEGACY_REVIEWED_WRITEBACK_CONTRACT,PINNED_REVIEWED_WRITEBACK_CONTRACT]){
      const bytes=reviewedWritebackContractBytes(contract.contractVersion);
      expect(verifyReviewedWritebackContract(bytes,digest(bytes))).toEqual(contract);
      expect(()=>verifyReviewedWritebackContract(bytes,`sha256:${'0'.repeat(64)}`))
        .toThrowError(expect.objectContaining({code:'UNVERIFIED_CONTRACT'}));
    }
    const channel=JSON.parse(readFileSync('server/research-memory/contracts/motive-writeback-channel-017.json','utf8'));
    expect(channel.components.schemas.EvidenceCreate.properties.expected_channel_id)
      .toMatchObject({type:'string',format:'uuid'});
    expect(channel.components.schemas.EvidenceCreate.required).not.toContain('expected_channel_id');
    const changed=Buffer.from(JSON.stringify({...channel,automatic_writeback_ready:true}));
    expect(()=>verifyReviewedWritebackContract(changed,digest(changed)))
      .toThrowError(expect.objectContaining({code:'UNVERIFIED_CONTRACT'}));
  });

  it('versions neutral evidence only from the frozen delivery contract',()=>{
    const channelId=randomUUID();const base:Delivery={id:randomUUID(),projectId:randomUUID(),scopeId:randomUUID(),
      mode:'NEW_DRAFT',target:null,targetBindingDigest:null,
      submissionId:randomUUID(),sourceIntentId:randomUUID(),sourceIntentPayloadDigest:`sha256:${'1'.repeat(64)}`,
      engineActor:`motive:project:${randomUUID()}`,apiBaseUrl:'https://engine.example/api/v1',configurationDigest:`sha256:${'2'.repeat(64)}`,
      apiVersion:'1.8.0',contractDigest:LEGACY_REVIEWED_WRITEBACK_CONTRACT.fileDigest,
      contractVersion:LEGACY_REVIEWED_WRITEBACK_CONTRACT.contractVersion,
      contractSurfaceDigest:LEGACY_REVIEWED_WRITEBACK_CONTRACT.surfaceDigest,
      implementationDigest:LEGACY_REVIEWED_WRITEBACK_CONTRACT.implementationDigest,payload:{scope:{channelId}}};
    const source={notes:{proposal:'p',expectation:'e',conditions:['c']},attribution:{},source:{},
      report:{status:'VALID',digest:`sha256:${'3'.repeat(64)}`,exactScore:'1',exceedsReference:false},
      reportBody:{result:{ok:true}},reportBinding:{submissionId:base.submissionId}} satisfies DeliverySource;
    const legacy=buildNeutralEvidenceBody(base,source,'circle-packing');
    expect(legacy).not.toHaveProperty('expected_channel_id');
    const current=buildNeutralEvidenceBody({...base,contractDigest:PINNED_REVIEWED_WRITEBACK_CONTRACT.fileDigest,
      contractVersion:PINNED_REVIEWED_WRITEBACK_CONTRACT.contractVersion,
      contractSurfaceDigest:PINNED_REVIEWED_WRITEBACK_CONTRACT.surfaceDigest,
      implementationDigest:PINNED_REVIEWED_WRITEBACK_CONTRACT.implementationDigest},source,'circle-packing');
    expect(current).toEqual({...legacy,expected_channel_id:channelId});
    expect(()=>buildNeutralEvidenceBody({...base,contractVersion:'hypothesis-http-writeback-capabilities/3',
      payload:{scope:{channelId:null}}},source,'circle-packing')).toThrowError(expect.objectContaining({code:'CONFLICT'}));
  });

  it('is dry-run by default and requires account, source, API approval, and contract references without accepting a key option',()=>{
    const accountId=randomUUID();const scopeId=randomUUID();const submissionId=randomUUID();const base=['--account-id',accountId,'--project','circle-packing',
      '--scope-id',scopeId,'--submission-id',submissionId,'--idempotency-key','prepare-12345678','--approved-api-base','https://engine.example/api/v1',
      '--contract-file','contracts/motive-writeback-local-017.json','--contract-digest',`sha256:${'a'.repeat(64)}`];
    expect(parseSyncProjectResearchArguments(base)).toMatchObject({selector:{accountId},scopeId,submissionId,execute:false});
    expect(parseSyncProjectResearchArguments([...base,'--execute']).execute).toBe(true);
    expect(()=>parseSyncProjectResearchArguments([...base,'--api-key','secret'])).toThrow();
    expect(()=>parseSyncProjectResearchArguments(base.slice(0,-2))).toThrow();
  });
});
