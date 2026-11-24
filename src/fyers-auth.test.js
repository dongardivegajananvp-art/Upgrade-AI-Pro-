import test from 'node:test';
import assert from 'node:assert/strict';
import { createLoginUrl, verifyLoginState, getAuthStatus, exchangeAuthCode, createSessionCookie, restoreSessionCookie, createRestSafetyCookie, restoreRestSafetyCookie } from './fyers-auth.js';

test('FYERS login URL includes configured redirect and cryptographic state',()=>{
 const login=createLoginUrl({appId:'TEST-100',redirectUri:'https://example.test/api/fyers/auth/callback'});
 const url=new URL(login.url);
 assert.equal(url.origin,'https://api-t1.fyers.in');
 assert.equal(url.searchParams.get('client_id'),'TEST-100');
 assert.equal(url.searchParams.get('redirect_uri'),'https://example.test/api/fyers/auth/callback');
 assert.equal(url.searchParams.get('response_type'),'code');
 assert.equal(url.searchParams.get('state'),login.state);
 assert.match(login.state,/^[a-f0-9]{48}$/);
 assert.equal(verifyLoginState(login.state,login.state),true);
 assert.equal(verifyLoginState(login.state,'0'.repeat(48)),false);
 assert.equal(verifyLoginState(login.state,undefined),false);
});
test('missing OAuth configuration is rejected',()=>{
 assert.throws(()=>createLoginUrl({appId:'',redirectUri:''}),/required/);
});
test('auth status never claims market data is connected before authentication',()=>{
 assert.equal(getAuthStatus().status,'NOT_AUTHENTICATED');
});
test('FYERS session survives process-memory loss through an encrypted HttpOnly cookie payload',async()=>{
 const originalFetch=globalThis.fetch;
 let requestCount=0;
 globalThis.fetch=async()=>({
   ok:true,status:200,
   headers:{get:()=>null},
   text:async()=>{requestCount++;return JSON.stringify({s:'ok',access_token:'sensitive-test-token'});}
 });
 try {
   await exchangeAuthCode({appId:'TEST-100',appSecret:'test-secret',authCode:'one-time-test-code'});
   const cookie=createSessionCookie({appId:'TEST-100',appSecret:'test-secret'});
   assert.ok(cookie.value.length>40);
   assert.equal(cookie.value.includes('sensitive-test-token'),false);
   assert.ok(cookie.maxAge>0);
   assert.equal(restoreSessionCookie(cookie.value,{appId:'TEST-100',appSecret:'test-secret'}),true);
   assert.equal(getAuthStatus().tokenStored,true);
   // A live process token must not make an arbitrary or tampered cookie valid.
   assert.equal(restoreSessionCookie('forged-cookie-value'.repeat(4),{appId:'TEST-100',appSecret:'test-secret'}),false);
   const tamperedCookie = cookie.value.slice(0, -1) + (cookie.value.endsWith('x') ? 'y' : 'x');
   assert.equal(restoreSessionCookie(tamperedCookie,{appId:'TEST-100',appSecret:'test-secret'}),false);
   await assert.rejects(
     exchangeAuthCode({appId:'TEST-100',appSecret:'test-secret',authCode:'one-time-test-code'}),
     /already been processed/
   );
   assert.equal(requestCount,1);
 } finally {
   globalThis.fetch=originalFetch;
 }
});


test('FYERS REST cooldown survives restart through an encrypted browser safety cookie',()=>{
 const now=Date.UTC(2026,10,24,5,0,0);
 const state={cooldownUntil:now+120000,rateLimitDayKey:'2026-11-24',rateLimitCountToday:2,cloudflareRateLimitCountToday:1,unknownRateLimitCountToday:0,lastRateLimitAt:new Date(now).toISOString(),lastRateLimitKind:'CLOUDFLARE_1015'};
 const cookie=createRestSafetyCookie({appId:'TEST-100',appSecret:'test-secret',state,now});
 assert.ok(cookie&&cookie.value.length>40);
 assert.equal(cookie.value.includes(String(state.cooldownUntil)),false);
 assert.deepEqual(restoreRestSafetyCookie(cookie.value,{appId:'TEST-100',appSecret:'test-secret',now:now+1000}),state);
 assert.equal(restoreRestSafetyCookie(cookie.value,{appId:'OTHER-100',appSecret:'test-secret',now}),null);
 assert.equal(restoreRestSafetyCookie(cookie.value,{appId:'TEST-100',appSecret:'wrong-secret',now}),null);
 const tampered=cookie.value.slice(0,-1)+(cookie.value.endsWith('x')?'y':'x');
 assert.equal(restoreRestSafetyCookie(tampered,{appId:'TEST-100',appSecret:'test-secret',now}),null);
 assert.equal(restoreRestSafetyCookie(cookie.value,{appId:'TEST-100',appSecret:'test-secret',now:cookie.expiresAt}),null);
});

test('FYERS REST safety cookie is not created when no active cooldown exists',()=>{
 assert.equal(createRestSafetyCookie({appId:'TEST-100',appSecret:'test-secret',state:{cooldownUntil:null},now:1000}),null);
});
