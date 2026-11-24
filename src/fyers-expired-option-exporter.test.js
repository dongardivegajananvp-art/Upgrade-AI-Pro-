import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { exportExpiredOptionPair } from './fyers-expired-option-exporter.js';

const underlying='NSE:NIFTY50-INDEX';
const expiry='2025-03-27';
const start='2025-03-26';
const end='2025-03-26';
const now=Date.parse('2025-03-30T00:00:00Z');
const quietSafeClock=()=>now;
const stamp=Math.floor(Date.parse('2025-03-26T03:50:00Z')/1000);
const candleStamp=Math.floor(Date.parse('2025-03-26T03:45:00Z')/1000);
const columns=['timestamp','open','high','low','close','volume'];

function clientFixture({ce='ok',pe='ok'}={}) {
  const calls=[];
  const client={
    async expiry_dates(args) {
      calls.push(['expiry_dates',args]);
      return {s:'ok',data:{symbol:underlying,expiry_dates:{options:[expiry],futures:[expiry]}}};
    },
    async history_underlying_symbols(args) {
      calls.push(['history_underlying_symbols',args]);
      return {s:'ok',data:{symbol:'NIFTY50',expiry_date:expiry,contracts:{options:[
        'NSE:NIFTY25MAR22950CE','NSE:NIFTY25MAR22950PE',
        'NSE:NIFTY25MAR23000CE','NSE:NIFTY25MAR23000PE',
        'NSE:NIFTY25MAR23050CE','NSE:NIFTY25MAR23050PE'
      ],futures:[]}}};
    },
    async fno_historical_data(args) {
      calls.push(['fno_historical_data',args]);
      const status=args.symbol.endsWith('CE')?ce:pe;
      return status==='no_data'
        ? {s:'no_data',symbol:args.symbol,resolution:'5',columns,candles:[]}
        : {s:'ok',symbol:args.symbol,resolution:'5',columns,candles:[[candleStamp,100,102,99,101,1200]]};
    }
  };
  return {client,calls};
}
async function withOutput(run) {
  const outputDir=await mkdtemp(path.join(os.tmpdir(),'fyers-expired-option-'));
  try { return await run(outputDir); } finally { await rm(outputDir,{recursive:true,force:true}); }
}
const base=outputDir=>({
  client:null,underlying,expiry,start,end,underlyingPrice:23012,
  selectionTime:stamp,outputDir,budgetDir:outputDir,now,clock:quietSafeClock,
  pause:async()=>{},minRequestGapMs:1000,maxIntradayRequests:10
});

test('expired option export discovers provider expiry and exact nearest-ATM CE/PE before fetching candles',async()=>{
  await withOutput(async outputDir=>{
    const {client,calls}=clientFixture();
    const result=await exportExpiredOptionPair({...base(outputDir),client});
    assert.equal(result.report.status,'PAIR_EXPORTED');
    assert.equal(result.report.strike,23000);
    assert.equal(result.report.contracts.CE,'NSE:NIFTY25MAR23000CE');
    assert.equal(result.report.contracts.PE,'NSE:NIFTY25MAR23000PE');
    assert.equal(result.report.requestCount,4);
    assert.equal(result.report.requestBudget.remaining,6);
    assert.deepEqual(calls.map(row=>row[0]),[
      'expiry_dates','history_underlying_symbols','fno_historical_data','fno_historical_data'
    ]);
    assert.equal(calls[2][1].include_oi,'0');
    assert.equal(calls[2][1].include_greeks,'0');
    assert.equal(calls[2][1].resolution,'5');
    assert.equal(result.report.actionable,false);
    const payload=JSON.parse(await readFile(path.join(outputDir,'NSE_NIFTY25MAR23000CE-'+start+'-'+String(stamp)+'.json'),'utf8'));
    assert.equal(payload.selection.historicalAtmSelection,true);
    assert.equal(payload.candles[0].source,'FYERS_EXPIRED_FO_5M');
    assert.equal(payload.candles[0].time,candleStamp);
    assert.equal(payload.timestampConvention,'FYERS_EPOCH_BAR_START');
    assert.equal(payload.actionable,false);
  });
});

test('expired option export marks missing contract candles PARTIAL and never fills missing data',async()=>{
  await withOutput(async outputDir=>{
    const {client}=clientFixture({pe:'no_data'});
    const result=await exportExpiredOptionPair({...base(outputDir),client});
    assert.equal(result.report.status,'PARTIAL');
    assert.equal(result.report.contractResults.PE.status,'NO_DATA');
    assert.equal(result.report.contractResults.PE.candleCount,0);
  });
});

test('expired option exporter rejects an expiry not confirmed by FYERS',async()=>{
  await withOutput(async outputDir=>{
    const {client}=clientFixture();
    client.expiry_dates=async()=>({s:'ok',data:{expiry_dates:{options:[]}}});
    await assert.rejects(()=>exportExpiredOptionPair({...base(outputDir),client}),/not present in FYERS/);
  });
});

test('expired option exporter blocks during the NSE live-session protection window before any API call',async()=>{
  await withOutput(async outputDir=>{
    const {client,calls}=clientFixture();
    const liveClock=()=>Date.parse('2025-03-25T05:00:00Z');
    await assert.rejects(()=>exportExpiredOptionPair({...base(outputDir),client,clock:liveClock}),/LIVE_SESSION_PROTECTION/);
    assert.equal(calls.length,0);
  });
});

test('expired option exporter rejects invalid ranges, unknown contract lists and unsafe request budgets',async()=>{
  await withOutput(async outputDir=>{
    const {client}=clientFixture();
    await assert.rejects(()=>exportExpiredOptionPair({...base(outputDir),client,maxIntradayRequests:3}),/4-to-10 request budget/);
    await assert.rejects(()=>exportExpiredOptionPair({...base(outputDir),client,end:'2025-03-27'}),/one trading date/);
    client.history_underlying_symbols=async()=>({s:'ok',data:{expiry_date:expiry,contracts:{options:[]}}});
    await assert.rejects(()=>exportExpiredOptionPair({...base(outputDir),client}),/no parseable option strikes/);
  });
});

test('expired option exporter refuses malformed, out-of-session and duplicate provider candles',async()=>{
  await withOutput(async outputDir=>{
    const {client}=clientFixture();
    client.fno_historical_data=async args=>({
      s:'ok',symbol:args.symbol,resolution:'5',columns,
      candles:[[stamp,100,102,99,101,100],[stamp,100,102,99,101,100]]
    });
    await assert.rejects(()=>exportExpiredOptionPair({...base(outputDir),client}),/duplicated/);
  });
});

test('expired option exporter requires completed historical underlying context and exact NSE symbols',async()=>{
  await withOutput(async outputDir=>{
    const {client}=clientFixture();
    await assert.rejects(()=>exportExpiredOptionPair({...base(outputDir),client,underlying:'BSE:SBIN-EQ'}),/verified NSE/);
    await assert.rejects(()=>exportExpiredOptionPair({...base(outputDir),client,underlyingPrice:0}),/completed historical underlying close/);
  });
});

test('expired option requests share one persistent ten-request IST daily budget across invocations',async()=>{
  const root=await mkdtemp(path.join(os.tmpdir(),'fyers-expired-budget-'));
  try {
    const budgetDir=path.join(root,'persistent-budget');
    const first=clientFixture();
    const one=await exportExpiredOptionPair({...base(path.join(root,'run-one')),budgetDir,client:first.client});
    assert.equal(one.report.requestBudget.usedToday,4);
    assert.equal(one.report.requestBudget.remainingToday,6);

    const second=clientFixture();
    const two=await exportExpiredOptionPair({...base(path.join(root,'run-two')),budgetDir,client:second.client});
    assert.equal(two.report.requestBudget.usedToday,8);
    assert.equal(two.report.requestBudget.remainingToday,2);

    const third=clientFixture();
    await assert.rejects(
      ()=>exportExpiredOptionPair({...base(path.join(root,'run-three')),budgetDir,client:third.client}),
      /daily request budget exhausted/
    );
    assert.equal(third.calls.length,2,'only the two remaining daily requests may reach FYERS');
  } finally {
    await rm(root,{recursive:true,force:true});
  }
});

test('expired option ATM export refuses multi-session ranges when only one historical close selects the strike',async()=>{
  await withOutput(async outputDir=>{
    const {client,calls}=clientFixture();
    await assert.rejects(()=>exportExpiredOptionPair({...base(outputDir),client,end:'2025-03-27'}),/one trading date/);
    assert.equal(calls.length,0,'invalid multi-session selection must be blocked before any FYERS request');
  });
});

test('expired option ATM selection requires a completed underlying close from the same NSE session',async()=>{
  await withOutput(async outputDir=>{
    const {client,calls}=clientFixture();
    const priorDay=Math.floor(Date.parse('2025-03-25T03:50:00Z')/1000);
    await assert.rejects(()=>exportExpiredOptionPair({...base(outputDir),client,selectionTime:priorDay}),/same trading date|selected trading date/);
    assert.equal(calls.length,0,'invalid historical close must be rejected before API requests');
  });
});



test('expired option export resumes from hash-verified checkpoints without repeating successful provider requests',async()=>{
  await withOutput(async outputDir=>{
    const {client,calls}=clientFixture();
    const original=client.fno_historical_data;
    let failPeOnce=true;
    client.fno_historical_data=async args=>{
      if(args.symbol.endsWith('PE')&&failPeOnce){failPeOnce=false;calls.push(['fno_historical_data_failed',args]);throw new Error('simulated transient PE response failure');}
      return original(args);
    };
    await assert.rejects(()=>exportExpiredOptionPair({...base(outputDir),client}),/simulated transient PE response failure/);
    assert.equal(calls.filter(row=>row[0]==='expiry_dates').length,1);
    assert.equal(calls.filter(row=>row[0]==='history_underlying_symbols').length,1);
    assert.equal(calls.filter(row=>row[0]==='fno_historical_data'&&row[1].symbol.endsWith('CE')).length,1);

    const resumed=await exportExpiredOptionPair({...base(outputDir),client});
    assert.equal(resumed.report.status,'PAIR_EXPORTED');
    assert.equal(resumed.report.requestCount,1,'only the missing PE candle request should be sent on resume');
    assert.equal(resumed.report.reusedCheckpointCount,3,'expiry, contract catalog and CE candles should be reused');
    assert.deepEqual(resumed.report.reusedCheckpoint,['expiry_dates','history_underlying_symbols','fno_historical_data_CE']);
    assert.equal(calls.filter(row=>row[0]==='expiry_dates').length,1);
    assert.equal(calls.filter(row=>row[0]==='history_underlying_symbols').length,1);
    assert.equal(calls.filter(row=>row[0]==='fno_historical_data'&&row[1].symbol.endsWith('CE')).length,1);
    assert.equal(calls.filter(row=>row[0]==='fno_historical_data'&&row[1].symbol.endsWith('PE')).length,1);
    assert.equal(resumed.report.requestBudget.usedToday,5,'the daily ledger must retain the failed request reservation');
  });
});

test('expired option exporter refuses a checkpoint whose cached response hash was modified',async()=>{
  await withOutput(async outputDir=>{
    const {client}=clientFixture();
    await exportExpiredOptionPair({...base(outputDir),client});
    const { readdir } = await import('node:fs/promises');
    const checkpointName=(await readdir(outputDir)).find(name=>name.startsWith('checkpoint-'));
    const checkpointPath=path.join(outputDir,checkpointName);
    const saved=JSON.parse(await readFile(checkpointPath,'utf8'));
    saved.responses.expiry_dates.response.data.expiry_dates.options=[];
    await (await import('node:fs/promises')).writeFile(checkpointPath,JSON.stringify(saved));
    await assert.rejects(()=>exportExpiredOptionPair({...base(outputDir),client}),/checkpoint response hash is invalid/);
  });
});
\ntest('expired option archive keeps the same contract across different historical session selections',async()=>{
 await withOutput(async outputDir=>{
  const first=clientFixture();
  const second=clientFixture();
  const one=await exportExpiredOptionPair({...base(outputDir),client:first.client});
  const laterStamp=stamp+300;
  const two=await exportExpiredOptionPair({...base(outputDir),client:second.client,selectionTime:laterStamp});
  assert.equal(one.report.contracts.CE,two.report.contracts.CE);
  assert.notEqual(one.report.contractResults.CE.file,two.report.contractResults.CE.file);
  assert.notEqual(one.report.requested.start+'-'+one.report.selectionTime,two.report.requested.start+'-'+two.report.selectionTime);
  const firstPayload=JSON.parse(await readFile(path.join(outputDir,one.report.contractResults.CE.file),'utf8'));
  const secondPayload=JSON.parse(await readFile(path.join(outputDir,two.report.contractResults.CE.file),'utf8'));
  assert.equal(firstPayload.selection.selectionTime,stamp);
  assert.equal(secondPayload.selection.selectionTime,laterStamp);
  assert.equal(firstPayload.candles[0].time,secondPayload.candles[0].time);
  assert.ok(one.report.requestCount+two.report.requestCount<=10);
 });
});
