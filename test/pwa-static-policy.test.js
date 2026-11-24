import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
const [worker,app]=await Promise.all([
  readFile(new URL('../public/sw.js',import.meta.url),'utf8'),
  readFile(new URL('../public/app.js',import.meta.url),'utf8')
]);

test('service worker uses a versioned shell cache and installs the complete app shell',()=>{
  assert.match(worker,/const CACHE='upgrade-ai-pro-shell-v\d+'/);
  assert.match(worker,/caches\.open\(CACHE\)\.then\(c=>c\.addAll\(FILES\)\)/);
  for(const path of ['/','/style.css','/app.js','/manifest.webmanifest','/session-snapshot.js'])assert.ok(worker.includes(path));
});

test('service worker never caches API or cross-origin responses and uses network-first shell fetch',()=>{
  assert.match(worker,/u\.origin!==location\.origin\|\|u\.pathname\.startsWith\('\/api\/'\)\)return/);
  assert.match(worker,/fetch\(e\.request\)\.catch\(\(\)=>caches\.match\(e\.request\)\)/);
});

test('service worker activation evicts obsolete caches and claims clients',()=>{
  assert.match(worker,/keys\.filter\(k=>k!==CACHE\)\.map\(k=>caches\.delete\(k\)\)/);
  assert.match(worker,/\.then\(\(\)=>self\.clients\.claim\(\)\)/);
});

test('frontend polling prevents overlap and pauses while the document is hidden',()=>{
  assert.match(app,/if \(refreshRunning \|\| document\.hidden\) return/);
  assert.match(app,/if \(refreshTimer \|\| document\.hidden\) return/);
  assert.match(app,/if \(document\.hidden\) stopStatusPolling\(\);\s*else startStatusPolling\(\)/);
  assert.match(app,/refreshTimer = setInterval\(refresh, 2000\)/);
});

test('Account Feed polling remains separately rate-limited to 120 seconds and single-flight',()=>{
  assert.match(app,/const ACCOUNT_REFRESH_INTERVAL_MS = 120_000/);
  assert.match(app,/if \(accountRefreshRunning\) return/);
  assert.match(app,/lastAccountRefresh = Date\.now\(\)/);
});