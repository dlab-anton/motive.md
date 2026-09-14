import type { FindingReviewHistoryDecision, FindingReviewHistoryPage } from './finding-assessment';
import { validFindingReviewPublicDecision } from './finding-review-client';

type JsonRecord = Record<string, unknown>;

const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const HISTORY_ERROR='Finding review history could not be read. Please try again.';
const HISTORY_DECISION_KEYS=['id','decision','outcome','finding','limitations','novelty','duplicateOfSubmissionId',
  'rationale','reviewedAt','packageDigest','evidence','hypothesis','previousDecisionId'] as const;

export class FindingHistoryReadError extends Error {
  constructor(message:string,readonly reset:boolean){super(message);this.name='FindingHistoryReadError';}
}

function isRecord(value:unknown):value is JsonRecord {
  if(!value||typeof value!=='object'||Array.isArray(value))return false;
  const prototype=Object.getPrototypeOf(value);
  return prototype===Object.prototype||prototype===null;
}

function exact(value:unknown,keys:readonly string[]):value is JsonRecord {
  return isRecord(value)&&Object.keys(value).length===keys.length&&keys.every(key=>Object.hasOwn(value,key));
}

function isUuid(value:unknown):value is string{return typeof value==='string'&&UUID.test(value);}

function validHistoryDecision(value:unknown,submissionId:string):value is FindingReviewHistoryDecision {
  if(!validFindingReviewPublicDecision(value,submissionId,HISTORY_DECISION_KEYS)||!isRecord(value))return false;
  const previousDecisionId=(value as JsonRecord).previousDecisionId;
  return (previousDecisionId===null||isUuid(previousDecisionId))&&previousDecisionId!==value.id;
}

function validHistory(value:unknown,submissionId:string):value is FindingReviewHistoryPage {
  if(!isUuid(submissionId)||!exact(value,['format','submissionId','latestDecisionId','items','nextCursor'])
    ||value.format!=='motive.finding-review.history/0.1'||value.submissionId!==submissionId
    ||!(value.latestDecisionId===null||isUuid(value.latestDecisionId))
    ||!Array.isArray(value.items)||value.items.length>20
    ||!(value.nextCursor===null||isUuid(value.nextCursor)))return false;
  if(value.latestDecisionId===null)return value.items.length===0&&value.nextCursor===null;
  if(!value.items.every(item=>validHistoryDecision(item,submissionId)))return false;
  const items=value.items as FindingReviewHistoryDecision[];
  const ids=new Set(items.map(item=>item.id));
  if(ids.size!==items.length)return false;
  for(let index=0;index<items.length-1;index+=1){
    if(items[index]!.previousDecisionId!==items[index+1]!.id)return false;
  }
  const last=items.at(-1);
  if(!last)return value.nextCursor===null;
  if(last.previousDecisionId===null)return value.nextCursor===null;
  return items.length===20&&value.nextCursor===last.id&&!ids.has(last.previousDecisionId);
}

function invalid(reset=false):FindingHistoryReadError{return new FindingHistoryReadError(HISTORY_ERROR,reset);}

export function parseFindingHistory(value:unknown,submissionId:string):FindingReviewHistoryPage {
  try{if(validHistory(value,submissionId))return value;}
  catch{/* Hostile response accessors are malformed and their errors stay private. */}
  throw invalid();
}

export async function readFindingHistory(submissionId:string,before:string|null,signal:AbortSignal):Promise<FindingReviewHistoryPage>{
  if(!isUuid(submissionId)||!(before===null||isUuid(before)))throw invalid();
  const path=`/api/public/projects/circle-packing/submissions/${submissionId}/finding-review/history${before?`?before=${before}`:''}`;
  let response:Response;
  try{
    response=await fetch(path,{method:'GET',credentials:'same-origin',redirect:'error',cache:'no-store',
      signal:AbortSignal.any([signal,AbortSignal.timeout(20_000)]),headers:{Accept:'application/json'}});
  }catch(error){if(signal.aborted)throw error;throw invalid();}
  if(response.status===404)throw invalid(true);
  if(!response.ok)throw invalid();
  let body:unknown;
  try{body=await response.json();}catch{throw invalid();}
  return parseFindingHistory(body,submissionId);
}
