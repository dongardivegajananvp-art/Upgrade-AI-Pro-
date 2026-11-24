import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const [server,auth,rest]=await Promise.all([
  readFile(new URL('../server.js',import.meta.url),'utf8'),
  readFile(new URL('../src/fyers-auth.js',import.meta.url),'utf8'),
  readFile(new URL('../src/fyers-rest.js',import.meta.url),'utf8')
]);

test('REST cooldown persistence is encrypted and scoped to the authenticated browser session',()=>{
  assert.match(server,/restoreRestSafetyCookie\(requestCookies\.fyers_rest_safety/);
  assert.match(server,/restoreRestSafetyState\(restoredSafety\)/);
  assert.match(server,/res\.__fyersRestSafetyCookieFactory/);
  assert.match(server,/fyers_rest_safety=.*HttpOnly; Secure; SameSite=Lax/);
  assert.match(server,/Path=\/api/);
  assert.match(auth,/createCipheriv\('aes-256-gcm', restSafetyKey/);
  assert.match(auth,/createDecipheriv\('aes-256-gcm',restSafetyKey/);
  assert.match(rest,/cooldownPersistence: 'ENCRYPTED_AUTHENTICATED_BROWSER_COOKIE_PER_SESSION'/);
});

test('safety cookie is refreshed only when this process has a newer active cooldown',()=>{
  assert.match(server,/Number\(restoredSafety\.cooldownUntil\)>=deadline/);
  assert.match(server,/deadline<=Date\.now\(\)\) return null/);
  assert.match(server,/const existing = res\.getHeader\('set-cookie'\)/);
});
