import type { Context,Config } from '@netlify/functions';
import {verify,queue,env} from './_shared/runtime.mts';
export default async (req:Request,context:Context)=>{
  const raw=await req.text();
  if(!verify(raw,req.headers))return new Response('Invalid signature',{status:401});
  let body:any;try{body=JSON.parse(raw)}catch{return new Response('Invalid JSON',{status:400})}
  if(body.type==='url_verification')return new Response(body.challenge);
  if(env('AUDIT_ENABLED')!=='true')return new Response('Audit not enabled',{status:503});
  const event=body.event;
  if(!event||event.type!=='message'||!event.text)return new Response('OK');
  try {await queue(context,{type:'event',body},`event:${body.event_id||event.channel+':'+event.ts}`);return new Response('OK')}
  catch{ return new Response('Unable to queue audit; retry',{status:503}) }
};
export const config:Config={path:'/slack/events',method:'POST'};
