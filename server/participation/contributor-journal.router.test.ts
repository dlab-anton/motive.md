import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import express from 'express';
import { describe, expect, it } from 'vitest';
import { createParticipationRouters } from './router.ts';
import { ParticipationError, type ParticipationService } from './service.ts';

async function listening(app:express.Express){const server=app.listen(0);await once(server,'listening');
  const address=server.address();if(!address||typeof address==='string')throw new Error('Test server did not bind.');
  return{server,origin:`http://127.0.0.1:${address.port}`};}

describe('public contributor research journal route',()=>{
  it('passes only canonical membership and cursor IDs and keeps every response private from caches',async()=>{
    const contributorId=randomUUID(),cursor=randomUUID();const calls:Array<{contributorId:string;before?:string}>=[];
    const service={publicContributorResearchJournal:async(id:string,before?:string)=>{calls.push({contributorId:id,before});
      if(id!==contributorId)throw new ParticipationError('NOT_FOUND','Contributor research journal was not found.');
      return{format:'motive.contributor-journal/0.1',projectSlug:'circle-packing',contributorId:id,items:[],nextCursor:null};}} as unknown as ParticipationService;
    const{publicRouter}=createParticipationRouters({service,isActorActive:async()=>true});
    const app=express();app.use('/api/public/projects/circle-packing',publicRouter);const{server,origin}=await listening(app);
    try{
      const root=`${origin}/api/public/projects/circle-packing/contributors/${contributorId}/research-updates`;
      const first=await fetch(root);expect(first.status).toBe(200);expect(first.headers.get('cache-control')).toBe('no-store');
      expect(await first.json()).toMatchObject({format:'motive.contributor-journal/0.1',contributorId});
      const next=await fetch(`${root}?before=${cursor}`);expect(next.status).toBe(200);
      expect(calls).toEqual([{contributorId,before:undefined},{contributorId,before:cursor}]);
      for(const path of [`${root}?limit=20`,`${root}?before=${cursor}&before=${cursor}`,
        `${root}?before=${cursor.toUpperCase()}`,`${root}?before=`,
        `${origin}/api/public/projects/circle-packing/contributors/${contributorId.toUpperCase()}/research-updates`,
        `${origin}/api/public/projects/circle-packing/contributors/not-a-uuid/research-updates`]){
        const response=await fetch(path);expect(response.status).toBe(400);expect(response.headers.get('cache-control')).toBe('no-store');
      }
      expect(calls).toHaveLength(2);
      const missing=await fetch(`${origin}/api/public/projects/circle-packing/contributors/${randomUUID()}/research-updates`);
      expect(missing.status).toBe(404);expect(missing.headers.get('cache-control')).toBe('no-store');
    }finally{server.close();await once(server,'close');}
  });
});
