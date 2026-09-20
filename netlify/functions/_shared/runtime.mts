import { createHmac, timingSafeEqual, createHash } from 'node:crypto';
import { getStore } from '@netlify/blobs';
import type { Context } from '@netlify/functions';
export function env(key: string) { return Netlify.env.get(key) || ''; }
export function equal(a: string,b: string) { return !!a && a.length===b.length && timingSafeEqual(Buffer.from(a),Buffer.from(b)); }
export function verify(raw:string, headers:Headers, now=Date.now()) {
  const stamp=headers.get('x-slack-request-timestamp')||'';
  if (!/^\d+$/.test(stamp)||Math.abs(now/1000-Number(stamp))>300||!env('SLACK_SIGNING_SECRET')) return false;
  return equal('v0='+createHmac('sha256',env('SLACK_SIGNING_SECRET')).update(`v0:${stamp}:${raw}`).digest('hex'),headers.get('x-slack-signature')||'');
}
export function jobs(context:Context) {
  const suffix=context.deploy.context==='production'?'production':context.deploy.id;
  return getStore({name:`cash-audit-jobs-${suffix}`,consistency:'strong'});
}
export async function runtime() {
  // Legacy modules read process.env. Netlify's environment is the source.
  for (const [key,value] of Object.entries(Netlify.env.toObject())) process.env[key]=value;
  const imported=await import('../../../server.js');
  return imported.default || imported;
}
export async function queue(context:Context, payload:any, identity:string) {
  if (!env('AUDIT_JOB_SECRET')) throw new Error('AUDIT_JOB_SECRET missing');
  const id=createHash('sha256').update(identity).digest('hex');
  const store=jobs(context);
  await store.setJSON(id,{status:'queued',createdAt:new Date().toISOString(),payload},{onlyIfNew:true});
  const current=await store.get(id,{type:'json'}) as any;
  if(current?.status==='done') return id;
  const origin=env('AUDIT_ORIGIN');
  if (!/^https:\/\/[a-z0-9-]+\.netlify\.app$/.test(origin)) throw new Error('AUDIT_ORIGIN missing or invalid');
  const accepted=await fetch(`${origin}/.netlify/functions/audit-background`,{method:'POST',headers:{'content-type':'application/json','x-audit-job-secret':env('AUDIT_JOB_SECRET')},body:JSON.stringify({id})});
  if(accepted.status!==202) throw new Error('Background dispatch failed');
  return id;
}
export async function invoke(path:string, method='GET', body:any=null, headers:Record<string,string>={}):Promise<any> {
  const {app}=await runtime();
  const {default:serverless}=await import('serverless-http');
  const url=new URL(path,'https://internal.invalid');
  return serverless(app)({httpMethod:method,path:url.pathname,rawUrl:url.href,queryStringParameters:Object.fromEntries(url.searchParams),headers,body:body==null?null:JSON.stringify(body),isBase64Encoded:false,requestContext:{}},{});
}
