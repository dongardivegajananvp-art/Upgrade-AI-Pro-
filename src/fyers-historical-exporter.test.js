import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { exportFyersHistoricalDataset } from './fyers-historical-exporter.js';

const MASTER='UPGRADE_AI_PRO_FYERS_NSE_FNO_MASTER_V1';
const PROV='FYERS_HISTORICAL_API';
const MASTER_PROV='FYERS_OFFICIAL_SYMBOL_MASTER';
const NOW=Date.parse('2026-11-24T10:00:00Z');
function dailyRows(){
  const rows=[];
  for(let i=120;i>=1;i--){
    const d=new Date(NOW); d.setUTCDate(d.getUTCDate()-i);
    const istMidnight=Math.floor((Date.UTC(d.getUTCFullYear(),d.getUTCMonth(),d.getUTCDate())-19800000)/1000);
    rows.push([istMidnight,100,105,95,102,1000]);
  }
  return rows;
}
async function fixture(t){
  const root=await mkdtemp(path.join(os.tmpdir(),'uapro-fyers-export-'));
  t.after(()=>rm(root,{recursive:true,force:true}));
  const masterFile=path.join(root,'master.json');
  await writeFile(masterFile,JSON.stringify({format:MASTER,source:MASTER_PROV,verifiedOfficialMaster:true,retrievedAt:'2026-11-24T09:00:00Z',sourceFiles:{NSE_FO:{url:'https://public.fyers.in/sym_details/NSE_FO_sym_master.json',sha256:'a'.repeat(64)},NSE_CM:{url:'https://public.fyers.in/sym_details/NSE_CM_sym_master.json',sha256:'b'.repeat(64)}},symbols:[{symbol:'NSE:SBIN-EQ'}]}));
  return {root,masterFile,outputDir:path.join(root,'dataset')};
}

test('exporter makes sequential official FYERS 5m and daily requests and writes hash manifest',async t=>{
 const dirs=await fixture(t); const calls=[];
 const fetchImpl=async(url,options)=>{
  calls.push({url:new URL(url),options});
  const resolution=new URL(url).searchParams.get('resolution');
  const prev=new Date(NOW-86400000); prev.setUTCHours(3,45,0,0);\n  const candles=resolution==='5'?[[Math.floor(prev.getTime()/1000),100,105,95,102,50]]:dailyRows();
  return {status:200,ok:true,text:async()=>JSON.stringify({s:'ok',candles})};
 };
 const result=await exportFyersHistoricalDataset({...dirs,appId:'APP-123',accessToken:'secret-token',fetchImpl,now:NOW,minRequestGapMs:1000,pause:async()=>{}});
 assert.equal(calls.length,2);
 assert.equal(calls[0].url.searchParams.get('resolution'),'5');
 assert.equal(calls[1].url.searchParams.get('resolution'),'D');
 assert.equal(calls[0].options.headers.Authorization,'APP-123:secret-token');
 assert.equal(result.manifest.complete,true);
 assert.equal(result.manifest.exportedCount,1);
 const manifest=JSON.parse(await readFile(result.manifestPath,'utf8'));
 assert.match(manifest.files[0].sha256,/^[a-f0-9]{64}$/);
 assert.match(manifest.files[0].apiEvidence.fiveMinute.responseSha256,/^[a-f0-9]{64}$/);
 const dataset=JSON.parse(await readFile(path.join(dirs.outputDir,manifest.files[0].file),'utf8'));
 assert.equal(dataset.dataProvenance,PROV);
 assert.equal(dataset.fiveMinuteCandles[0].source,'FYERS_HISTORY_5M');
 assert.equal(dataset.dailyCandles.length,120);
});

test('exporter halts on FYERS 429 without retrying or continuing universe',async t=>{
 const dirs=await fixture(t); let calls=0;
 const result=await exportFyersHistoricalDataset({...dirs,appId:'APP',accessToken:'TOKEN',now:NOW,minRequestGapMs:1000,pause:async()=>{},fetchImpl:async()=>{calls++;return {status:429,ok:false,text:async()=>JSON.stringify({s:'error',message:'rate limited'})};}});
 assert.equal(calls,1);
 assert.equal(result.manifest.complete,false);
 assert.equal(result.manifest.exportedCount,0);
 assert.match(result.manifest.failures[0].reason,/HTTP 429/);
});

test('exporter rejects unverified master and invalid candle rows instead of repairing them',async t=>{
 const dirs=await fixture(t);
 await writeFile(dirs.masterFile,JSON.stringify({format:MASTER,source:MASTER_PROV,verifiedOfficialMaster:false,sourceFiles:{NSE_FO:{sha256:'a'.repeat(64)},NSE_CM:{sha256:'b'.repeat(64)}},symbols:['NSE:SBIN-EQ']}));
 await assert.rejects(exportFyersHistoricalDataset({...dirs,appId:'APP',accessToken:'TOKEN',now:NOW}),/verified FYERS official/);
 await writeFile(dirs.masterFile,JSON.stringify({format:MASTER,source:PROV,verifiedOfficialMaster:true,symbols:['NSE:SBIN-EQ']}));
 const invalid=await exportFyersHistoricalDataset({...dirs,appId:'APP',accessToken:'TOKEN',now:NOW,minRequestGapMs:1000,pause:async()=>{},fetchImpl:async()=>({status:200,ok:true,text:async()=>JSON.stringify({s:'ok',candles:[[1,1,1,1,1,1]]})})});
 assert.equal(invalid.manifest.complete,false);
 assert.match(invalid.manifest.failures[0].reason,/Invalid or duplicate FYERS 5-minute candle/);
});

test('exporter source has no imports from live REST scheduler or live workstation',async()=>{
 const source=await readFile(new URL('./fyers-historical-exporter.js',import.meta.url),'utf8');
 assert.doesNotMatch(source,/fyers-rest|rest-scheduler|server\\.js|fyers-auth/);
});
