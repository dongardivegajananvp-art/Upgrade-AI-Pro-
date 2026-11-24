import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const [server,app]=await Promise.all([
  readFile(new URL('../server.js',import.meta.url),'utf8'),
  readFile(new URL('../public/app.js',import.meta.url),'utf8')
]);

test('closed-session historical setups use the explicit research-only candidate state',()=>{
  assert.match(server,/status:'LAST_SESSION_RESEARCH_CANDIDATE'/);
  assert.match(server,/mode:'HISTORICAL_ONLY_NOT_LIVE'/);
  assert.match(server,/No live tick, option quote, option candle, entry, stop or target is inferred/);
  assert.match(app,/LAST SESSION RESEARCH CANDIDATE · NOT LIVE/);
  assert.match(app,/LAST SESSION RESEARCH CANDIDATES · NOT LIVE · NOT ACTIONABLE/);
  assert.match(app,/NO TRADE until live gates pass/);
});
