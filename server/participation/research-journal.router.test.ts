import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import express from 'express';
import { describe, expect, it } from 'vitest';
import { createParticipationRouters } from './router.ts';
import { ParticipationError, type ParticipationService } from './service.ts';

async function listening(app:express.Express){const server=app.listen(0);await once(server,'listening');
  const address=server.address();if(!address||typeof address==='string')throw new Error('Test server did not bind.');
  return{server,origin:`http://127.0.0.1:${address.port}`};}

describe('research journal routes',()=>{
  it('strictly validates public cursors and keeps success and errors private from caches',async()=>{
    const cursor=randomUUID(),submissionId=randomUUID();const pages:Array<string|undefined>=[];const entries:string[]=[];
    const citations:Array<{submissionId:string;before?:string}>=[];
    const service=({publicResearchJournal:async(before?:string)=>{pages.push(before);
      return{format:'motive.research-journal-page/0.1',items:[],nextCursor:null};},
    publicResearchCitations:async(id:string,before?:string)=>{citations.push({submissionId:id,before});
      return{format:'motive.research-journal-page/0.1',items:[],nextCursor:null};},
    publicResearchJournalEntry:async(id:string)=>{entries.push(id);if(id!==submissionId)
      throw new ParticipationError('NOT_FOUND','Research journal entry was not found.');return{entry:true};}}) as unknown as ParticipationService;
    const{publicRouter}=createParticipationRouters({service,isActorActive:async()=>true});
    const app=express();app.use('/api/public/projects/circle-packing',publicRouter);const{server,origin}=await listening(app);
    try{
      const root=`${origin}/api/public/projects/circle-packing/research-updates`;
      const first=await fetch(root);expect(first.status).toBe(200);expect(first.headers.get('cache-control')).toBe('no-store');
      const next=await fetch(`${root}?before=${cursor}`);expect(next.status).toBe(200);
      const focused=await fetch(`${root}/${submissionId}`);expect(focused.status).toBe(200);
      const citing=await fetch(`${root}/${submissionId}/citing?before=${cursor}`);expect(citing.status).toBe(200);
      expect(citing.headers.get('cache-control')).toBe('no-store');
      expect(pages).toEqual([undefined,cursor]);expect(entries).toEqual([submissionId]);
      expect(citations).toEqual([{submissionId,before:cursor}]);
      for(const path of [`${root}?other=${cursor}`,`${root}?before=${cursor}&before=${cursor}`,
        `${root}?before=${cursor.toUpperCase()}`,`${root}/${submissionId}?before=${cursor}`,
        `${root}/${submissionId}/citing?other=${cursor}`,`${root}/${submissionId}/citing?before=${cursor.toUpperCase()}`]){
        const response=await fetch(path);expect(response.status).toBe(400);
        expect(response.headers.get('cache-control')).toBe('no-store');
      }
      const missing=await fetch(`${root}/${randomUUID()}`);expect(missing.status).toBe(404);
      expect(missing.headers.get('cache-control')).toBe('no-store');
      const invalidCiting=await fetch(`${root}/not-a-uuid/citing`);expect(invalidCiting.status).toBe(404);
      expect(invalidCiting.headers.get('cache-control')).toBe('no-store');
      expect(citations).toHaveLength(1);
    }finally{server.close();await once(server,'close');}
  });

  it('derives the owner from the mounted account session boundary',async()=>{
    const actorId=`account:${randomUUID()}`,cursor=randomUUID();const calls:Array<{actorId:string;before?:string}>=[];
    const ownershipCalls:Array<{actorId:string;ids:string[]}>=[];
    const service={ownedResearchJournal:async(owner:string,before?:string)=>{calls.push({actorId:owner,before});
      return{format:'motive.research-journal-page/0.1',items:[],nextCursor:null};},
    submissionOwnership:async(owner:string,ids:string[])=>{ownershipCalls.push({actorId:owner,ids});
      return{format:'motive.submission-ownership/0.1',ownedSubmissionIds:ids};}} as unknown as ParticipationService;
    const{accountRouter}=createParticipationRouters({service,isActorActive:async()=>true});
    const app=express();app.use('/api/participation',(req,res,next)=>{if(req.get('Authorization')==='Bearer current-session'){
      res.locals.actorId=actorId;res.locals.accountName='Current account';}next();},accountRouter);
    const{server,origin}=await listening(app);
    try{
      const url=`${origin}/api/participation/research-updates`;
      const denied=await fetch(url);expect(denied.status).toBe(401);expect(denied.headers.get('cache-control')).toBe('no-store');
      const allowed=await fetch(`${url}?before=${cursor}`,{headers:{Authorization:'Bearer current-session'}});
      expect(allowed.status).toBe(200);expect(allowed.headers.get('cache-control')).toBe('no-store');
      expect(calls).toEqual([{actorId,before:cursor}]);
      const override=await fetch(`${url}?actorId=account:${randomUUID()}`,{headers:{Authorization:'Bearer current-session'}});
      expect(override.status).toBe(400);expect(override.headers.get('cache-control')).toBe('no-store');
      expect(calls).toHaveLength(1);

      const ownershipUrl=`${origin}/api/participation/submission-ownership`;const firstId=randomUUID(),secondId=randomUUID();
      const ownershipDenied=await fetch(`${ownershipUrl}?ids=${firstId}`);
      expect(ownershipDenied.status).toBe(401);expect(ownershipDenied.headers.get('cache-control')).toBe('no-store');
      const ownership=await fetch(`${ownershipUrl}?ids=${firstId},${secondId}`,{headers:{Authorization:'Bearer current-session'}});
      expect(ownership.status).toBe(200);expect(ownership.headers.get('cache-control')).toBe('no-store');
      expect(await ownership.json()).toEqual({format:'motive.submission-ownership/0.1',ownedSubmissionIds:[firstId,secondId]});
      expect(ownershipCalls).toEqual([{actorId,ids:[firstId,secondId]}]);
      const tooMany=Array.from({length:65},()=>randomUUID()).join(',');
      for(const path of [`${ownershipUrl}`,`${ownershipUrl}?other=${firstId}`,
        `${ownershipUrl}?ids=${firstId}&ids=${secondId}`,`${ownershipUrl}?ids=${firstId},${firstId}`,
        `${ownershipUrl}?ids=${firstId.toUpperCase()}`,`${ownershipUrl}?ids=not-a-uuid`,`${ownershipUrl}?ids=${tooMany}`]){
        const response=await fetch(path,{headers:{Authorization:'Bearer current-session'}});
        expect(response.status).toBe(400);expect(response.headers.get('cache-control')).toBe('no-store');
      }
      expect(ownershipCalls).toHaveLength(1);
    }finally{server.close();await once(server,'close');}
  });
});
