import test from 'node:test';
import assert from 'node:assert/strict';
import { shouldReuseAuthenticatedSession } from '../src/fyers-auth.js';

test('authenticated session is reused only when an encrypted refresh session is available', () => {
  assert.equal(shouldReuseAuthenticatedSession({hasSession:true,auth:{tokenStored:true,refreshTokenStored:true}}),true);
  assert.equal(shouldReuseAuthenticatedSession({hasSession:true,auth:{tokenStored:true,refreshTokenStored:false}}),false);
  assert.equal(shouldReuseAuthenticatedSession({hasSession:false,auth:{tokenStored:true,refreshTokenStored:true}}),false);
  assert.equal(shouldReuseAuthenticatedSession({hasSession:true,auth:{tokenStored:false,refreshTokenStored:true}}),false);
});
