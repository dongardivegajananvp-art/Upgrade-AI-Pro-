import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { buildNseFnoEquityUniverse, downloadOfficialNseFnoEquityMaster, FYERS_MASTER_URLS } from './backtest-symbol-master-exporter.js';

function masters(count=60){
 const fo={},cm={};
 for(let i=0;i<count;i++){
  const n=String(i).padStart(3,'0');const token='FY'+n;const ticker='NSE:STOCK'+n+'-EQ';
  cm[ticker]={symTicker:ticker,fyToken:token,exSeries:'EQ',tradeStatus:1,exSymbol:'STOCK'+n,lastUpdate:'2026-11-23'};
  fo['NSE:STOCK'+n+'26NOV100CE']={symTicker:'NSE:STOCK'+n+'26NOV100CE',underFyTok:token,optType:'CE'};
 }
 return {fo,cm};
}
test('maps F&O underlying FY tokens to active NSE cash EQ tickers only',()=>{
 const {fo,cm}=masters();const symbols=buildNseFnoEquityUniverse(fo,cm);
 assert.equal(symbols.length,60);assert.ok(symbols.every(x=>x.symbol.startsWith('NSE:')&&x.symbol.endsWith('-EQ')));
 assert.equal(symbols[0].foInstrumentCount,1);
});
test('rejects incomplete or non-matching official master mappings',()=>{
 assert.throws(()=>buildNseFnoEquityUniverse({},{}),/empty or malformed/);
 const {fo,cm}=masters();for(const row of Object.values(cm))row.tradeStatus=0;
 assert.throws(()=>buildNseFnoEquityUniverse(fo,cm),/fewer than 50/);
});
test('downloads both official FYERS master files, preserves raw bytes and writes attested master',async t=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'uapro-symbol-master-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 const data=masters();const payloads={NSE_FO:Buffer.from(JSON.stringify(data.fo).padEnd(2000,' ')),NSE_CM:Buffer.from(JSON.stringify(data.cm).padEnd(2000,' '))};const urls=[];
 const result=await downloadOfficialNseFnoEquityMaster({outputDir:dir,now:Date.parse('2026-11-24T10:00:00Z'),fetchImpl:async url=>{urls.push(url);const name=url.includes('NSE_FO')?'NSE_FO':'NSE_CM';return{ok:true,status:200,arrayBuffer:async()=>payloads[name]};}});
 assert.deepEqual(urls,[FYERS_MASTER_URLS.NSE_FO,FYERS_MASTER_URLS.NSE_CM]);
 assert.equal(result.master.source,'FYERS_OFFICIAL_SYMBOL_MASTER');assert.equal(result.master.verifiedOfficialMaster,true);assert.equal(result.master.symbols.length,60);
 assert.deepEqual(await readFile(path.join(dir,'NSE_FO_sym_master.json')),payloads.NSE_FO);
 const manifest=JSON.parse(await readFile(result.masterFile,'utf8'));
 assert.match(manifest.sourceFiles.NSE_FO.sha256,/^[a-f0-9]{64}$/);assert.match(manifest.sourceFiles.NSE_CM.sha256,/^[a-f0-9]{64}$/);
});
test('master downloader fails closed on HTTP error or malformed JSON',async t=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'uapro-symbol-master-fail-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 await assert.rejects(downloadOfficialNseFnoEquityMaster({outputDir:dir,fetchImpl:async()=>({ok:false,status:503,arrayBuffer:async()=>Buffer.from('x')})}),/download failed/);
});
