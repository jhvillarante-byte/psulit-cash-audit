import type { Context } from '@netlify/functions';
import {equal,env,jobs,runtime,invoke} from './_shared/runtime.mts';
export default async(req:Request,context:Context)=>{
 if(!equal(env('AUDIT_JOB_SECRET'),req.headers.get('x-audit-job-secret')||''))return;
 const {id}=await req.json();if(!/^[a-f0-9]{64}$/.test(id))return;
 const store=jobs(context);const stored=await store.getWithMetadata(id,{type:'json'});if(!stored)return;
 const job=stored.data as any;if(job.status!=='queued')return; // Failed/partial jobs require review, never blind reposts.
 const lock=await store.setJSON(id,{...job,status:'running',startedAt:new Date().toISOString()},{onlyIfMatch:stored.etag});
 if(!lock.modified)return;
 try {
   const service=await runtime();const p=job.payload;let result:any=null;
   if(p.type==='event')await service.processSlackEvent(p.body);
   else if(p.type==='resolution')await service.discrepancyResolutionWorkflow.viewSubmission(p.payload);
   else if(p.type==='diagnostic') {const slack=await import('../../slack.js');await slack.postEphemeral(p.channel,p.user,await service.runHiveDiagnostic());}
   else if(p.type==='manual') {result=await invoke(p.path);if(result.statusCode>=400)throw new Error('Audit endpoint failed');}
   else throw new Error('Unknown job type');
   await store.setJSON(id,{...job,status:'done',finishedAt:new Date().toISOString(),result});
 }catch(error){await store.setJSON(id,{...job,status:'failed',failedAt:new Date().toISOString(),error:String((error as Error).message)});throw error;}
};
