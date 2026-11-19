import test from 'node:test';
import assert from 'node:assert/strict';
import { createLoginUrl, verifyLoginState, getAuthStatus } from './fyers-auth.js';

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
test('auth status never claims market data is connected',()=>{
 assert.equal(getAuthStatus().status,'NOT_AUTHENTICATED');
});
