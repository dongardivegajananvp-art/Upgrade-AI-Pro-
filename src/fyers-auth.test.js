import test from 'node:test';
import assert from 'node:assert/strict';
import { createLoginUrl, verifyLoginState, getAuthStatus, exchangeAuthCode, createSessionCookie, restoreSessionCookie } from './fyers-auth.js';

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
   assert.equal(restoreSessionCookie(cookie.value.slice(0,-1)+'x',{appId:'TEST-100',appSecret:'test-secret'}),false);
   await assert.rejects(
     exchangeAuthCode({appId:'TEST-100',appSecret:'test-secret',authCode:'one-time-test-code'}),
     /already been processed/
   );
   assert.equal(requestCount,1);
 } finally {
   globalThis.fetch=originalFetch;
 }
});
