import type { Context,Config } from '@netlify/functions';
import {verify,queue,runtime,env} from './_shared/runtime.mts';
export default async (req:Request,context:Context)=>{
 const raw=await req.text();if(!verify(raw,req.headers))return new Response('Invalid signature',{status:401});
 if(env('AUDIT_ENABLED')!=='true')return new Response('Audit not enabled',{status:503});
 const form=new URLSearchParams(raw);const {discrepancyResolutionWorkflow:workflow}=await runtime();
 if(form.get('command')==='/hive-audit-diagnostic') {
   const user=form.get('user_id')||'';if(!env('SLACK_MANAGER_USER_IDS').split(',').map(s=>s.trim()).includes(user))return new Response('Not authorized');
   await queue(context,{type:'diagnostic',channel:form.get('channel_id'),user},`diagnostic:${req.headers.get('x-slack-request-timestamp')}:${user}`);return new Response('Checking Hive…');
 }
 let payload:any;try{payload=JSON.parse(form.get('payload')||'{}')}catch{return new Response('Invalid payload',{status:400})}
 if(payload.type==='block_actions') {await workflow.blockAction(payload);return new Response('');}
 if(payload.type==='view_submission'&&payload.view?.callback_id==='resolve_discrepancy_modal') {
   const errors=workflow.validateSubmission(payload);
   if(Object.keys(errors).length)return Response.json({response_action:'errors',errors});
   try{await queue(context,{type:'resolution',payload},`resolution:${payload.view.id}:${payload.view.hash}`)}catch{return Response.json({response_action:'errors',errors:{notes:'Unable to save now. Please retry.'}})}
 }
 return new Response('');
};
export const config:Config={path:'/slack/interactions',method:'POST'};
