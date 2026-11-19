import test from 'node:test';
import assert from 'node:assert/strict';
import { createLoginUrl, consumeLoginState, getAuthStatus } from './fyers-auth.js';

test('FYERS login URL contains configured redirect and a one-time state',()=>{
 const url=new URL(createLoginUrl({appId:'TEST-100',redirectUri:'https://example.test/api/fyers/auth/callback'}));
 assert.equal(url.origin,'https://api-t1.fyers.in');
 assert.equal(url.searchParams.get('client_id'),'TEST-100');
 assert.equal(url.searchParams.get('redirect_uri'),'https://example.test/api/fyers/auth/callback');
 assert.equal(url.searchParams.get('response_type'),'code');
 const state=url.searchParams.get('state');
 assert.equal(consumeLoginState(state),true);
 assert.equal(consumeLoginState(state),false);
});
test('missing OAuth configuration is rejected',()=>{
 assert.throws(()=>createLoginUrl({appId:'',redirectUri:''}),/required/);
});
test('auth status never claims market data is connected',()=>{
 assert.equal(getAuthStatus().status,'NOT_AUTHENTICATED');
});
