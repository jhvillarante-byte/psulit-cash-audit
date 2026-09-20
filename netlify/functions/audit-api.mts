import type {Context,Config} from '@netlify/functions';
import {env,equal,queue,jobs,invoke} from './_shared/runtime.mts';
export default async(req:Request,context:Context)=>{
 const url=new URL(req.url);
 if(url.pathname==='/health'){
   const missing=['SLACK_BOT_TOKEN','SLACK_SIGNING_SECRET','BRANCHES','SLACK_MANAGER_USER_IDS','AUDIT_JOB_SECRET','AUDIT_ORIGIN'].filter(k=>!env(k));
   return Response.json({service:'PSulit Cash Audit',host:'Netlify',configured:!missing.length,enabled:env('AUDIT_ENABLED')==='true',missing},{status:missing.length?503:200});
 }
 if(url.pathname==='/internal/balance-preview') {
   if(!equal(env('BALANCE_PREVIEW_SECRET'),req.headers.get('x-balance-preview-secret')||''))return new Response('Unauthorized',{status:401});
   const result=await invoke('/internal/balance-preview','POST',await req.json(),{'content-type':'application/json','x-balance-preview-secret':env('BALANCE_PREVIEW_SECRET')});
   return new Response(result.body,{status:result.statusCode,headers:{'content-type':'application/json'}});
 }
 if(!equal(env('AUDIT_ADMIN_SECRET'),req.headers.get('x-audit-admin-secret')||''))return new Response('Unauthorized',{status:401});
 if(req.method==='GET'&&url.pathname.startsWith('/api/jobs/')){
   const id=url.pathname.split('/').pop()||'';if(!/^[a-f0-9]{64}$/.test(id))return new Response('Invalid ID',{status:400});
   const job=await jobs(context).get(id,{type:'json'}) as any;return job?Response.json({status:job.status,result:job.result,error:job.error}):new Response('Not found',{status:404});
 }
 if(req.method==='POST'&&url.pathname==='/api/audits') {
   const body=await req.json();if(!['Solaire','Alphaland'].includes(body.branch))return new Response('Invalid branch',{status:400});
   const mode=body.mode==='handover'?'handover':'shift-audit';
   const query=new URLSearchParams({branch:body.branch,...(body.dryRun===false?{}:{dry:'1'})});
   const id=await queue(context,{type:'manual',path:`/test/${mode}?${query}`},`manual:${crypto.randomUUID()}`);
   return Response.json({jobId:id,status:'queued'},{status:202});
 }
 return new Response('Not found',{status:404});
};
export const config:Config={path:['/health','/internal/balance-preview','/api/audits','/api/jobs/:id']};
