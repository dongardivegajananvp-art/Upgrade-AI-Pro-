import { isNseRegularSession, normalizeTopGainersSnapshot, resolveTopGainersView, normalizeChartSnapshot } from './session-snapshot.js';
import { getOptionRetryDelayMs } from './option-retry-policy.js';
const labels = [
  ['NSE:NIFTY50-INDEX','nifty','nifty-change','nifty-feed-age'],
  ['NSE:NIFTYBANK-INDEX','bank','bank-change','bank-feed-age'],
  ['NSE:FINNIFTY-INDEX','finnifty','finnifty-change','finnifty-feed-age']
];
let selectedSymbol = null;
let userSelectedSymbol = false;
let lastAutoTop3CandidateKey = null;
let symbolSelectionGeneration = 0;
let optionSelectionGeneration = 0;
let optionSelectionRetryAt = 0;
let optionSelectionRetrySymbol = null;
let optionSelectionRetryMode = 'MANUAL';
let optionSelectionRetrySide = null;
let optionSelectionRetryExpiry = null;
let optionChainRetryAt = 0;
let optionChainRetrySymbol = null;
let optionChainRetryTimestamp = '';
let optionChainRetryGeneration = 0;
let refreshRunning = false;
let indexScanRefreshRunning = false;
let lastIndexScanRefresh = 0;
let chartRestoredFromCache = false;
const TOP_GAINERS_SNAPSHOT_KEY = 'upgrade-ai-pro:last-session-top5:v1';
const CHART_SNAPSHOT_KEY = 'upgrade-ai-pro:last-verified-chart:v1';
const ACTIVE_SETUP_KEY = 'upgrade-ai-pro:active-setups:v1';
let activeSetups = (() => { try { const rows=JSON.parse(localStorage.getItem(ACTIVE_SETUP_KEY)||'[]'); return Array.isArray(rows)?rows.filter(row=>row&&row.id&&row.contract&&row.status):[]; } catch { return []; } })();
let activeSetupSyncAt = 0;
let selectedUnderlyingPrice = null;
let optionChainRows = [];
let selectedOptionSide = 'CE';
let selectedContractSymbol = null;
let accountRefreshRunning = false;
let chartCandles = [];
let chartLiveCandle = null;
let chartViewMode = 'UNDERLYING';
let chartViewSymbol = null;
let chartViewGeneration = 0;
let chartSetupLevels = null;
let chartZoom = 1;
let chartPan = 0;
let chartPriceZoom = 1;
let chartGestureActive = false;
let chartFollowLive = true;
let chartLastTouchTap = 0;
let setupEvaluationRunning = false;
let setupEvaluationDone = false;
let setupLastBucket = null;
let setupOptionTrigger = null;
let setupRetryAfter = 0;
let researchContextReadySymbol = null;
let researchContextLoadingSymbol = null;
let researchContextLoadingPromise = null;
let researchContextRetryAt = 0;
const ACCOUNT_REFRESH_INTERVAL_MS = 120_000;
let lastAccountRefresh = 0;
let lastUniverseScanRefresh = 0;
let universeScanRunning = false;
document.querySelectorAll('.indices article[data-symbol]').forEach(card => {
  const open = () => selectIndexSymbol(card.dataset.symbol);
  card.addEventListener('click', open);
  card.addEventListener('keydown', event => {
    if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); open(); }
  });
});
function tickStatusText(md, freshCount) {
  if (!isNseRegularSession(Date.now())) return 'MARKET CLOSED · FYERS LAST PRICES · NOT LIVE';
  if (freshCount === 3 && md.socketStatus !== 'CONNECTED') return 'FYERS RECONNECTING · LAST TICKS NOT CONFIRMED';
  if (freshCount > 0) return 'FYERS PARTIAL / STALE · ' + freshCount + '/3 INDEX TICKS FRESH';
  return 'FYERS STALE · WAITING FOR FRESH EXCHANGE TICKS';
}
function saveActiveSetups() { try { localStorage.setItem(ACTIVE_SETUP_KEY,JSON.stringify(activeSetups.slice(-10))); } catch {} }
function mergeActiveSetups(rows=[]) {
  if(!Array.isArray(rows)||!rows.length)return;
  const activeBefore=activeSetups.filter(row=>row.status==='ACTIVE').length;
  const byId=new Map(activeSetups.map(row=>[row.id,row]));
  for(const row of rows) { if(!row?.id)continue; const prior=byId.get(row.id); byId.set(row.id,prior?.status&&prior.status!=='ACTIVE'?prior:{...prior,...row}); }
  activeSetups=[...byId.values()].slice(-10);
  const activeAfter=activeSetups.filter(row=>row.status==='ACTIVE').length;
  if(activeAfter<activeBefore) {
    // A closed setup releases a slot. Re-arm automatic candidate handoff;
    // the server excludes the exited underlying until a newer 5m candle closes.
    userSelectedSymbol=false;
    lastAutoTop3CandidateKey=null;
  }
  saveActiveSetups();renderActiveSetups();
}
async function syncActiveSetups(force=false) {
  const active=activeSetups.filter(row=>row.status==='ACTIVE');
  if(!force&&Date.now()-activeSetupSyncAt<15000)return;activeSetupSyncAt=Date.now();
  try { const response=await fetch('/api/active-setups',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({setups:active})});const result=await response.json();if(response.ok&&Array.isArray(result.setups))mergeActiveSetups(result.setups); } catch {}
}
function registerTriggeredSetup(setup,underlying,contract) {
  const entryAt=new Date().toISOString();
  const id=contract+'|'+String(setup.optionCandleTime||setup.confirmedAt||entryAt);
  const sameTrigger=activeSetups.find(row=>row.id===id);
  if(sameTrigger)return {ok:true,existing:true,row:sameTrigger};
  const duplicate=activeSetups.find(row=>row.status==='ACTIVE'&&(row.contract===contract||row.underlying===underlying));
  if(duplicate)return {ok:true,existing:true,row:duplicate};
  if(activeSetups.filter(row=>row.status==='ACTIVE').length>=2)return {ok:false,reason:'Two verified setups are already active; existing Entry/SL/Target levels are being retained'};
  const entry=Number(setup.entry),stopLoss=Number(setup.stopLoss),target=Number(setup.target),risk=entry-stopLoss,reward=target-entry;
  if(!(entry>0&&stopLoss>0&&stopLoss<entry&&target>entry&&risk>0&&reward/risk>=2))return {ok:false,reason:'Fixed Entry/SL/Target failed minimum 1:2 risk validation'};
  const row={id,underlying,contract,strategy:setup.strategy||'VERIFIED_STRATEGY',optionSide:setup.optionSide||null,entry,stopLoss,target,rr:Number((reward/risk).toFixed(4)),entryAt,setupCandleTime:Number(setup.underlyingCandleTime)||null,status:'ACTIVE',feedStatus:'WAITING_FOR_TICK',lastObservedPrice:null,exitPrice:null,closedAt:null};
  activeSetups.push(row);
  // After an entry is retained, let the independent scanner hand off the next
  // eligible underlying instead of remaining pinned to the just-triggered one.
  userSelectedSymbol=false;lastAutoTop3CandidateKey=null;
  saveActiveSetups();renderActiveSetups();void syncActiveSetups(true);return {ok:true,existing:false,row};
}
async function viewActiveOptionChart(row) {
  const contract=String(row?.contract||'');
  if(!/^NSE:[A-Z0-9&._-]+$/.test(contract)) return;
  const generation=++chartViewGeneration;
  chartViewMode='OPTION';chartViewSymbol=contract;chartLiveCandle=null;
  chartSetupLevels={
    entry:Number(row.entry),stopLoss:Number(row.stopLoss),target:Number(row.target)
  };
  resetChartViewport();
  const title=document.querySelector('#symbol'),area=document.querySelector('#chart-area');
  title.textContent=contract+' · LOADING VERIFIED FYERS OPTION HISTORY';
  document.querySelector('#chart-candle-status').textContent='OPTION STRIKE · LOADING COMPLETED FYERS 5-MIN CANDLES';
  area.replaceChildren();
  const loading=document.createElement('div');loading.className='chart-empty';
  loading.textContent='Loading this exact entered option contract from FYERS history. No synthetic candles are used.';
  area.append(loading);
  try {
    const response=await fetch('/api/option-history?symbol='+encodeURIComponent(contract),{cache:'no-store'});
    const data=await response.json();
    if(generation!==chartViewGeneration||chartViewMode!=='OPTION'||chartViewSymbol!==contract)return;
    if(!response.ok||!Array.isArray(data.candles)||!data.candles.length)
      throw new Error(data.reason||'Verified FYERS option candles are unavailable');
    drawHistoryChart(data.candles);
    title.textContent=contract+' · OPTION STRIKE CHART · '+(data.count??data.candles.length)+' COMPLETED FYERS 5-MIN CANDLES';
    document.querySelector('#chart-candle-status').textContent='EXACT OPTION CONTRACT · COMPLETED FYERS HISTORY · ENTRY / SL / TARGET LEVELS';
    document.querySelector('#chart-area')?.scrollIntoView?.({behavior:'smooth',block:'start'});
    const market=await fetch('/api/market-data',{cache:'no-store'}).then(r=>r.json()).catch(()=>null);
    if(generation===chartViewGeneration&&chartViewMode==='OPTION') updateOptionChartLiveStatus(market,contract);
  } catch(error) {
    if(generation!==chartViewGeneration||chartViewMode!=='OPTION'||chartViewSymbol!==contract)return;
    area.replaceChildren();
    const note=document.createElement('div');note.className='chart-empty';
    note.textContent=String(error.message||'Option history unavailable')+' · NO SYNTHETIC DATA · NO TRADE';
    area.append(note);
    title.textContent=contract+' · OPTION CHART UNAVAILABLE';
    document.querySelector('#chart-candle-status').textContent='OPTION HISTORY NOT VERIFIED';
  }
}
function updateOptionChartLiveStatus(market,contract) {
  const row=(market?.activeOptionTicks||[]).find(item=>item.symbol===contract);
  const tick=row?.tick||null;
  const status=document.querySelector('#chart-candle-status');
  const panel=document.querySelector('#live-candle-summary');
  if(tick?.fresh) {
    const clock=new Date(Number(tick.exchangeTime)*1000).toLocaleTimeString('en-IN',{timeZone:'Asia/Kolkata',hour:'2-digit',minute:'2-digit',second:'2-digit',hour12:false});
    status.textContent='OPTION CHART · LIVE FYERS TICK FRESH ₹'+showNumber(tick.price)+' · '+clock+' IST · HISTORICAL COMPLETED 5M CANDLES';
    if(panel) panel.textContent='LIVE OPTION TICK · ₹'+showNumber(tick.price)+' · '+clock+' IST · EXCHANGE-TIMESTAMP VERIFIED';
  } else {
    status.textContent='OPTION CHART · LIVE TICK '+(tick?'STALE':'NOT AVAILABLE')+' · VERIFIED HISTORICAL 5M CANDLES ONLY';
    if(panel) panel.textContent='OPTION CHART · LIVE TICK '+(tick?'STALE':'NOT PINNED')+' · NO LIVE CANDLE IS SYNTHESIZED';
  }
}
function renderActiveSetups() {
  let panel=document.getElementById('active-setups-panel');
  if(!panel) { panel=document.createElement('section');panel.id='active-setups-panel';panel.style.cssText='margin:10px 0;padding:10px;border:1px solid #31445f;border-radius:10px;background:#0c1828;color:#dceaff;';const state=document.getElementById('setup-state');if(state?.parentNode)state.parentNode.insertBefore(panel,state.nextSibling); }
  panel.replaceChildren();const heading=document.createElement('strong');heading.textContent='TRIGGERED SETUPS · RETAINED UNTIL SL / TARGET';heading.style.cssText='display:block;font-size:12px;margin-bottom:8px;letter-spacing:.3px;';panel.append(heading);
  if(!activeSetups.length) { const empty=document.createElement('div');empty.textContent='No triggered setup is currently retained.';empty.style.fontSize='11px';panel.append(empty);return; }
  for(const row of [...activeSetups].reverse()) {
    const card=document.createElement('div');card.style.cssText='padding:8px 0;border-top:1px solid #263951;font-size:11px;line-height:1.6;';
    const title=document.createElement('strong');title.textContent=(row.underlying||'NSE STOCK')+' · '+(row.contract||'OPTION');
    const status=document.createElement('span');status.textContent='  ·  '+(row.status==='ACTIVE'?'ACTIVE · '+(row.feedStatus||'WAITING FOR TICK'):row.status.replaceAll('_',' '));
    status.style.color=row.status==='ACTIVE'?'#72e5c0':row.status==='TARGET_HIT'?'#72e5c0':'#ff9a9a';
    const levels=document.createElement('div');levels.textContent='ENTRY ₹'+showNumber(row.entry)+'  ·  SL ₹'+showNumber(row.stopLoss)+'  ·  TARGET ₹'+showNumber(row.target)+'  ·  RR 1:'+showNumber(row.rr,2);
    const observed=document.createElement('div');observed.textContent=row.lastObservedPrice!=null?'LAST VERIFIED OPTION ₹'+showNumber(row.lastObservedPrice)+(row.exitPrice!=null?' · EXIT ₹'+showNumber(row.exitPrice):''):'Waiting for fresh option tick to monitor exit';
    observed.style.color='#9fb1c9';
    const view=document.createElement('button');view.type='button';view.textContent='VIEW CHART';view.style.cssText='margin-top:6px;padding:7px 12px;border:1px solid #3b82f6;border-radius:7px;background:#12213a;color:#bfdbfe;font-weight:700;font-size:10px;cursor:pointer;';
    view.addEventListener('click',()=>void viewActiveOptionChart(row));
    card.append(title,status,levels,observed,view);panel.append(card);
  }
}
function showNumber(value, digits=2) {
  return Number.isFinite(Number(value)) ? Number(value).toLocaleString('en-IN',{maximumFractionDigits:digits}) : '—';
}
function showExpiry(value) {
  const stamp=Number(value);
  return Number.isFinite(stamp)&&stamp>0?new Date((stamp+19800)*1000).toISOString().slice(0,10):'—';
}

async function refreshIndexStrategyScan() {
  if(indexScanRefreshRunning) return;
  indexScanRefreshRunning=true;
  lastIndexScanRefresh=Date.now();
  const status=document.querySelector('#index-strategy-status');
  const container=document.querySelector('#index-strategy-results');
  try {
    const response=await fetch('/api/research/indices',{cache:'no-store'});
    const data=await response.json();
    if(!response.ok) throw new Error(data.reason||'Index strategy scanner unavailable · HTTP '+response.status);
    status.textContent=(data.freshIndexCount||0)+'/'+(data.totalIndexCount||3)+' INDEX TICKS FRESH · '+(data.scannerStatus||'UNKNOWN')+' · '+(data.marketSession||'UNKNOWN')+' · SHARED REST 2/MIN';
    container.replaceChildren();
    for(const row of data.scans||[]) {
      const card=document.createElement('div');
      card.style.cssText='padding:10px 0;border-top:1px solid #263951;font-size:12px;line-height:1.55;';
      const title=document.createElement('strong');
      title.textContent=(row.label||row.symbol)+' · '+(row.feedStatus==='FRESH'?'FRESH TICK':'STALE / MISSING TICK');
      const result=document.createElement('div');
      result.textContent=row.status==='UNDERLYING_SETUP_CONFIRMED'
        ?(row.tradeStatus==='OPTION_CONFIRMATION_REQUIRED_NO_TRADE'
          ?'UNDERLYING SETUP CONFIRMED · OPTION CHECK PENDING · NO TRADE'
          :!row.scanCurrent?'PREVIOUS CANDLE SETUP · WAITING FOR LATEST 5M BAR · NO TRADE'
            :row.feedStatus!=='FRESH'?'INDEX FEED STALE · NO TRADE'
              :'UNDERLYING SETUP · NO TRADE')
        :(row.status||'WAITING').replaceAll('_',' ');
      result.style.cssText='font-weight:700;color:'+(row.status==='UNDERLYING_SETUP_CONFIRMED'&&row.tradeStatus!=='NO_TRADE'?'#72e5c0':'#dceaff')+';';
      const detail=document.createElement('div');
      detail.textContent='STRATEGY '+(row.strategy||'—')+' · SIDE '+(row.side||'—')+' · PRICE '+(row.tickFresh?'₹'+showNumber(row.tickPrice):'—');
      const candle=document.createElement('div');
      const candleTime=row.lastCompletedCandleTime?new Date(Number(row.lastCompletedCandleTime)*1000).toLocaleTimeString('en-IN',{timeZone:'Asia/Kolkata',hour:'2-digit',minute:'2-digit',hour12:false})+' IST':'—';
      const scannedAt=row.lastScanAt?new Date(row.lastScanAt).toLocaleTimeString('en-IN',{timeZone:'Asia/Kolkata',hour:'2-digit',minute:'2-digit',second:'2-digit',hour12:false})+' IST':'WAITING';
      candle.textContent='COMPLETED 5M CANDLE '+candleTime+' · SCANNED '+scannedAt+' · CHECKS '+(row.strategyCheckCount||0)+'/9 · 15M CONTEXT '+(row.fifteenMinuteHistoryStatus||'WAITING')+' ('+(row.fifteenMinuteCandleCount||0)+')';
      const reason=document.createElement('small');
      reason.className='empty-inline';
      reason.textContent=row.reason||'Waiting for next verified completed 5-minute candle';
      card.append(title,result,detail,candle,reason);
      const details=document.createElement('details');
      const summary=document.createElement('summary');
      summary.textContent='NINE-STRATEGY LEDGER · '+(row.strategyLedger||[]).length+' RULES';
      details.append(summary);
      for(const entry of row.strategyLedger||[]) {
        const line=document.createElement('div');
        line.className='strategy-ledger-row';
        const name=document.createElement('b');
        name.textContent=(entry.strategy||'STRATEGY')+' · '+(entry.status||'UNKNOWN');
        const why=document.createElement('small');
        why.textContent=entry.reason||'No reason returned';
        line.append(name,why);
        details.append(line);
      }
      card.append(details);
      container.append(card);
    }
    if(!(data.scans||[]).length) {
      const empty=document.createElement('div');
      empty.className='empty-inline';
      empty.textContent=data.note||'No index scan records are available.';
      container.append(empty);
    }
    const note=document.createElement('div');
    note.className='empty-inline';
    note.textContent='UNDERLYING SCAN ONLY · '+(data.scanReady?'3/3 FRESH INDEX FEED VERIFIED':'WAITING FOR 3/3 FRESH INDEX FEED')+' · OPTION CE/PE TICK + COMPLETED OPTION CANDLE REQUIRED BEFORE ANY TRADE · ORDERS DISABLED';
    container.append(note);
  } catch(error) {
    status.textContent='INDEX NINE-STRATEGY SCAN UNAVAILABLE';
    container.textContent=String(error.message||'Index strategy scanner unavailable');
  } finally {
    indexScanRefreshRunning=false;
  }
}

async function refreshUniverseScan() {
  if(universeScanRunning) return;
  universeScanRunning=true;lastUniverseScanRefresh=Date.now();
  const status=document.querySelector('#universe-scan-status');
  const container=document.querySelector('#universe-scan-results');
  try {
    const response=await fetch('/api/research/universe',{cache:'no-store'});
    const data=await response.json();
    // Once a fresh completed-candle price setup exists, route the #1
    // candidate into read-only CE/PE verification unless the user has chosen
    // a chart symbol manually. This never places an order.
    const activeCount=activeSetups.filter(row=>row.status==='ACTIVE').length;
    const availableSlots=Math.max(0,2-activeCount);
    if(data.marketSession==='OPEN'&&availableSlots>0&&!userSelectedSymbol&&Array.isArray(data.top3)&&data.top3.length) {
      const activeUnderlyings=new Set(activeSetups.filter(row=>row.status==='ACTIVE').map(row=>row.underlying));
      const nextCandidate=data.top3.find(item=>item?.symbol&&!activeUnderlyings.has(item.symbol));
      if(nextCandidate&&['LONG','SHORT'].includes(nextCandidate.side)) {
        // PRICE_SETUP is intentionally unscored. It may be handed to the option
        // verifier, but cannot become a trade until fresh option confirmation,
        // completed option candles and fixed RR >= 1:2 all pass.
        const candidateKey=[nextCandidate.symbol,nextCandidate.strategy,nextCandidate.side,nextCandidate.lastCompletedCandleTime].join('|');
        if(candidateKey!==lastAutoTop3CandidateKey) {
          lastAutoTop3CandidateKey=candidateKey;
          selectCandidateForEntry(nextCandidate,{automatic:true});
        }
      }
    }
    container.replaceChildren();
    const lastScanAt=data.scanner?.lastScanAt?new Date(data.scanner.lastScanAt).toLocaleTimeString('en-IN',{timeZone:'Asia/Kolkata',hour:'2-digit',minute:'2-digit',second:'2-digit',hour12:false})+' IST':'WAITING';
    status.textContent=(data.universeCount||0)+' F&O · HISTORY SCANS '+(data.scanner?.sliceScannedCount||0)+'/'+(data.scanPerSlice||2)+' BUDGET · SOCKET SLICE '+(data.sliceSize||20)+' · UNIVERSE CHECKED '+(data.coverageSummary?.scannedCount||0)+'/'+(data.universeCount||0)+' · CANDLES '+(data.candleReceivedThisSlice||0)+' · STRATEGY CHECKS '+(data.strategyChecksThisSlice||0)+' · EST. FULL PASS '+(data.fullCycleMinutes??'—')+' MIN · LAST '+lastScanAt+' · REST-GOVERNED'+(data.marketSession==='CLOSED'?' · MARKET CLOSED · SCANNER PAUSED':'');
    const note=document.createElement('div');note.className='empty-inline';
    note.textContent=(data.marketSession==='CLOSED'?'NSE MARKET CLOSED · LIVE SCANNER AND RESEARCH WARMUPS ARE PAUSED UNTIL THE NEXT REGULAR SESSION. ':'')+(Number(data.strategyChecksThisSlice||0)===0?'NO TRADE - DATA NAHI · Waiting for this slice’s verified history checks; Top 3 stays suppressed until a completed check is available. ':'')+'Twenty F&O symbols rotate into the live socket each minute; the REST governor currently permits '+(data.scanPerSlice||2)+' history scans per slice. Fresh Top-5 gainers are prioritized when their own FYERS ticks are fresh. The estimated full pass is '+(data.fullCycleMinutes??'—')+' minutes. Coverage is rolling, not simultaneous. Underlying candidates remain non-actionable until the selected option has its own fresh tick, completed 5m candle and premium breakout. Current candidates: '+(data.candidateCount||0)+'.';
    container.append(note);
    const cycle=document.createElement('small');cycle.className='empty-inline';
    cycle.textContent='OPPORTUNITY CYCLE · '+(data.opportunityCycleStatus||'SCANNING')+' · ACTIVE '+(data.activeSetupCount??activeSetups.filter(row=>row.status==='ACTIVE').length)+'/2 · FREE SLOTS '+(data.availableSetupSlots??Math.max(0,2-activeSetups.filter(row=>row.status==='ACTIVE').length))+' · '+(data.excludedUntilNextFiveMinuteCandle?.length||0)+' RECENT EXIT COOLDOWNS UNTIL NEW 5M BAR';
    container.append(cycle);
    const scanner=data.scanner||{};
    const warmup=document.createElement('small');warmup.className='empty-inline';
    warmup.textContent='RESEARCH · '+(data.marketSession==='CLOSED'?'PAUSED':(scanner.warmupStatus||'IDLE'))+
      ' · Q '+(scanner.warmupQueueDepth||0)+' · DONE '+(scanner.warmupCompletedCount||0)+
      ' · RETRY '+(scanner.warmupRetryCount||0)+' · BLOCK '+(scanner.warmupRejectedCount||0);
    container.append(warmup);
    for(const item of data.top3||[]) {
      const card=document.createElement('button');card.type='button';card.className='research-card';
      const head=document.createElement('div');head.className='research-card-head';
      const scored=item.qualityScore!==null&&item.qualityScore!==undefined&&Number.isFinite(Number(item.qualityScore));
      const title=document.createElement('strong');title.textContent=(scored?'#'+(item.rank||'—'):'CANDIDATE '+(item.rank||'—'))+' '+item.symbol+' · '+item.strategy+' · '+item.side;
      const score=document.createElement('b');score.textContent=scored?item.qualityScore+'/100 · '+item.grade:'UNSCORED PRICE SETUP · OPTION CHECK PENDING';
      head.append(title,score);
      const evidence=document.createElement('small');evidence.textContent=(item.evidence||[]).join(' · ');
      const target=document.createElement('small');target.textContent=item.qualityScore===null?'Risk rule: Entry/SL/Target only after official option verification · RR ≥ 2':'AI target: '+(item.targetR||2)+'R · '+(item.targetRationale||'Minimum 2R');
      const reason=document.createElement('small');reason.textContent='Invalidation: '+(item.invalidation||'Not supplied');
      card.append(head,evidence,target,reason);
      card.addEventListener('click',()=>void selectCandidateForEntry(item));
      container.append(card);
    }
    if(!(data.top3||[]).length) {
      const blocked=document.createElement('small');
      blocked.textContent='No fresh completed-candle price setup yet. Missing/stale data and unconfirmed patterns are not promoted.';
      container.append(blocked);
    }
    // Keep the default DOM intentionally small on mobile. Detailed ledgers are
    // available for the current active slice only; the full rolling universe is
    // represented by aggregate counts instead of rendering 218 nested rows.
    const activeSet=new Set(data.activeSymbols||[]);
    const coverageBySymbol=new Map((data.symbolCoverage||[]).map(row=>[row.symbol,row]));
    const activeEvaluationsAll=(data.evaluations||[]).filter(row=>activeSet.has(row.symbol));
    const activeEvaluations=activeEvaluationsAll.slice(0,4);
    const diagnostics=document.createElement('details');
    const diagnosticsTitle=document.createElement('summary');
    diagnosticsTitle.textContent='ACTIVE SLICE · '+activeEvaluationsAll.length+' STOCKS · SHOWING '+activeEvaluations.length+' DETAILS';
    diagnostics.append(diagnosticsTitle);
    for(const stock of activeEvaluations) {
      const coverage=coverageBySymbol.get(stock.symbol)||{};
      const neverScanned=Number(coverage.scanAttempts||0)===0;
      const candleCount=Number(coverage.candleCount||0);
      const group=document.createElement('details');
      const summary=document.createElement('summary');
      const scanLabel=neverScanned?'AWAITING HISTORY SCAN':coverage.scanStatus||stock.status;
      summary.textContent=stock.symbol+' · '+scanLabel+' · '+(stock.fresh?'FRESH TICK':'STALE / MISSING TICK');
      group.append(summary);
      const evidence=document.createElement('small');
      evidence.className='empty-inline';
      evidence.textContent='5-MIN HISTORY · '+(neverScanned?'NOT REQUESTED YET':candleCount+' COMPLETED CANDLES')+
        ' · LAST COMPLETED · '+(coverage.lastCompletedCandleTime||'—')+
        ' · LAST SCAN · '+(coverage.lastScanAt||'—');
      group.append(evidence);
      if(neverScanned) {
        const waiting=document.createElement('small');
        waiting.textContent=coverage.scanReason||'Waiting for its guarded REST history rotation slot; no candle-staleness conclusion is available yet.';
        group.append(waiting);
      } else {
        for(const item of stock.strategyLedger||[]) {
          const row=document.createElement('div');row.className='strategy-ledger-row';
          const label=document.createElement('b');label.textContent=item.strategy+' · '+item.status;
          const reason=document.createElement('small');reason.textContent=item.reason||'No reason returned';
          row.append(label,reason);group.append(row);
        }
        if(!stock.strategyLedger?.length && coverage.scanReason) {
          const reason=document.createElement('small');reason.textContent=coverage.scanReason;group.append(reason);
        }
      }
      diagnostics.append(group);
    }
    container.append(diagnostics);
    const coverage=data.coverageSummary||{};
    const coverageAudit=document.createElement('details');
    const coverageTitle=document.createElement('summary');
    coverageTitle.textContent='F&O COVERAGE · '+(coverage.scannedCount||0)+'/'+(coverage.universeCount||0)+' SCANNED · '+(coverage.freshTickCount||0)+' FRESH · '+(coverage.staleTickCount||0)+' STALE · '+(coverage.noTickCount||0)+' NO TICK';
    coverageAudit.append(coverageTitle);
    const coverageNote=document.createElement('small');coverageNote.className='empty-inline';
    coverageNote.textContent='Rolling coverage, not simultaneous. Per-symbol history is intentionally hidden here to keep the live workstation responsive.';
    coverageAudit.append(coverageNote);
    container.append(coverageAudit);
    if(!isNseRegularSession(Date.now())) {
      const historicalHeading=document.createElement('div');historicalHeading.className='empty-inline';
      historicalHeading.textContent='LAST SESSION RESEARCH CANDIDATES · NOT LIVE · NOT ACTIONABLE';
      container.append(historicalHeading);
      const historicalResponse=await fetch('/api/research/historical-universe',{cache:'no-store'});
      const historical=await readJsonResponse(historicalResponse,'HISTORICAL F&O RESEARCH');
      if(!historicalResponse.ok)throw new Error(historical.reason||'Historical research unavailable');
      const historicalStatus=document.createElement('small');
      historicalStatus.className='empty-inline';
      historicalStatus.textContent=(historical.candidateCount||0)+' LAST SESSION RESEARCH CANDIDATES · '+(historical.evaluatedCount||0)+' CANDLE SETS EVALUATED · '+(historical.blockedCount||0)+' MISSING HISTORY · '+(historical.universeCount||0)+' OFFICIAL F&O';
      container.append(historicalStatus);
      for(const item of historical.candidates||[]) {
        const card=document.createElement('button');card.type='button';card.className='research-card historical-research-card';
        const head=document.createElement('div');head.className='research-card-head';
        const title=document.createElement('strong');title.textContent=item.symbol+' · '+item.strategy+' · '+item.side;
        const state=document.createElement('b');state.textContent='LAST SESSION RESEARCH CANDIDATE · NOT LIVE';
        head.append(title,state);
        const details=document.createElement('small');
        details.textContent='Last verified 5m candle: '+new Date((Number(item.asOfCandleTime)+19800)*1000).toISOString().replace('T',' ').slice(0,16)+' IST · Underlying close ₹'+showNumber(item.underlyingPrice)+' · Breakout level ₹'+showNumber(item.breakoutLevel);
        const disclaimer=document.createElement('small');
        disclaimer.textContent='Research candidate only. No live underlying tick, option quote, option candles, Entry, SL or Target verified. NO TRADE until live gates pass.';
        card.append(head,details,disclaimer);
        card.addEventListener('click',()=>selectUserSymbol(item.symbol));
        container.append(card);
      }
      if(!(historical.candidates||[]).length) {
        const empty=document.createElement('small');empty.className='empty-inline';
        empty.textContent='No historical candidate is currently proven from cached verified candles. Missing history is counted as blocked; no sample setup is shown.';
        container.append(empty);
      }
      const historicalAudit=document.createElement('details');
      const auditTitle=document.createElement('summary');
      auditTitle.textContent='HISTORICAL F&O COVERAGE AUDIT · '+(historical.evaluations||[]).length+' SYMBOLS';
      historicalAudit.append(auditTitle);
      for(const stock of historical.evaluations||[]) {
        const group=document.createElement('details');
        const summary=document.createElement('summary');
        summary.textContent=stock.symbol+' · '+stock.status+' · '+(stock.strategy||'NO CONFIRMED PATTERN');
        group.append(summary);
        if(stock.reason) {
          const reason=document.createElement('small');reason.className='empty-inline';reason.textContent=stock.reason;group.append(reason);
        }
        for(const item of stock.strategyLedger||[]) {
          const row=document.createElement('div');row.className='strategy-ledger-row';
          const label=document.createElement('b');label.textContent=item.strategy+' · '+item.status;
          const reason=document.createElement('small');reason.textContent=item.reason||'No reason returned';
          row.append(label,reason);group.append(row);
        }
        historicalAudit.append(group);
      }
      container.append(historicalAudit);
    }
  } catch(error) {
    status.textContent='UNIVERSE SCAN UNAVAILABLE';
    container.textContent=String(error.message||'Cached FYERS universe evaluation unavailable');
  } finally {universeScanRunning=false;}
}
async function refresh() {
  if (refreshRunning || document.hidden) return;
  refreshRunning = true;
  try {
    const r = await fetch('/api/status',{cache:'no-store'});
    if (!r.ok) throw new Error('status unavailable');
    const s = await r.json();
    const restState = s.rest || {};
    const accountRefreshSafe = !restState.cooldownActive && !restState.queueDrainActive &&
      Number(restState.queueDepth || 0) === 0 && Number(restState.requestsThisMinute || 0) < 4;
    if (s.auth?.tokenStored && Date.now() - lastAccountRefresh >= ACCOUNT_REFRESH_INTERVAL_MS && accountRefreshSafe) refreshAccount();
    else if (!s.auth?.tokenStored) {
      document.querySelector('#positions-data').textContent = 'Connect FYERS to read current-day positions and P&L.';
      document.querySelector('#orders-data').textContent = 'Connect FYERS to read today’s order status.';
      const accountStatus = document.querySelector('#account-feed-status');
      if (accountStatus) accountStatus.textContent = 'FYERS ACCOUNT FEED · SESSION REQUIRED';
    }
    const md = s.marketData || {};
    mergeActiveSetups(md.activeSetups||[]);
    if(s.auth?.tokenStored) void syncActiveSetups();
    if(s.auth?.tokenStored && Date.now()-lastUniverseScanRefresh>=30000) refreshUniverseScan();
    if(s.auth?.tokenStored && Date.now()-lastIndexScanRefresh>=15000) refreshIndexStrategyScan();
    renderMovers(md.fno || {});
    if (selectedSymbol && setupEvaluationDone && researchContextReadySymbol !== selectedSymbol && !researchContextLoadingSymbol && Date.now() >= researchContextRetryAt) {
      void ensureResearchContext(selectedSymbol).catch(() => {});
    }
    const optionTick = md.selectedOption;
    const underlyingTick = md.selectedUnderlying;
    // Restore the backend's selected chart symbol after a page reload; otherwise
    // the server can build a live candle while the client never renders it.
    if ((!selectedSymbol || (chartRestoredFromCache && selectedSymbol === underlyingTick?.symbol)) &&
        underlyingTick?.symbol && underlyingTick.fresh) {
      selectSymbol(underlyingTick.symbol, underlyingTick.price);
    }
    // Update the chart candle from this exact status snapshot before rendering
    // its summary. This keeps OHLCV and live price aligned to one FYERS tick.
    if (chartViewMode==='UNDERLYING' && selectedSymbol && underlyingTick?.symbol === selectedSymbol && underlyingTick.fresh) {
      chartLiveCandle = underlyingTick.liveCandle || null;
      if (!chartGestureActive) renderChartViewport();
    }
    if(chartViewMode==='OPTION'&&chartViewSymbol) updateOptionChartLiveStatus(md,chartViewSymbol);
    else renderLiveCandleSummary(underlyingTick);
    const optionLtp = document.querySelector('#option-ltp');
    const optionStatus = document.querySelector('#option-status');
    if (optionTick?.fresh && optionTick.symbol === selectedContractSymbol) {
      optionLtp.textContent = '₹' + showNumber(optionTick.price);
      if (optionStatus) {
        const exchangeClock = new Date(Number(optionTick.exchangeTime) * 1000).toLocaleTimeString('en-IN', {
          timeZone:'Asia/Kolkata', hour:'2-digit', minute:'2-digit', second:'2-digit', hour12:false
        });
        const baseStatus = optionStatus.textContent.replace(/ · LIVE TICK (?:PENDING|STALE|FRESH(?: @ [^·]+)?)/g, '');
        optionStatus.textContent = baseStatus + ' · LIVE TICK FRESH @ ' + exchangeClock + ' IST';
      }
      const selectedTick = md.selectedUnderlying;
      const bucket = selectedTick?.exchangeTime ? Math.floor(Number(selectedTick.exchangeTime)/300)*300 : null;
      if (bucket && setupLastBucket !== null && bucket !== setupLastBucket) {
        setupEvaluationDone = false; setupOptionTrigger = null; setupRetryAfter = 0;
      }
      if (setupRetryAfter && Date.now() >= setupRetryAfter) { setupEvaluationDone = false; setupRetryAfter = 0; }
      // A WAITING_FOR_OPTION_BREAKOUT result is a live trigger, not a final verdict.
      // Re-evaluate only when a fresh option tick crosses the exact official-tick entry.
      if (setupOptionTrigger && setupOptionTrigger.bucket === bucket && optionTick?.fresh &&
          Number(optionTick.price) + setupOptionTrigger.tickSize * 1e-7 >= setupOptionTrigger.entryTriggerPrice) {
        setupOptionTrigger = null; setupEvaluationDone = false;
      }
      // Entry evaluation is dispatched once below, after every readiness check is refreshed.
    }
    else if (selectedContractSymbol) {
      optionLtp.textContent = optionTick ? 'STALE · NOT ACTIONABLE' : 'WAITING FOR LIVE OPTION TICK';
      if (optionStatus) {
        const baseStatus = optionStatus.textContent.replace(/ · LIVE TICK (?:PENDING|STALE|FRESH(?: @ [^·]+)?)/g, '');
        optionStatus.textContent = baseStatus + (optionTick ? ' · LIVE TICK STALE' : ' · LIVE TICK PENDING');
      }
    }
    // Centralized dispatch: this runs after status, contract and research readiness
    // have all been refreshed, not only inside the option-LTP rendering branch.
    if(optionSelectionRetryAt && Date.now()>=optionSelectionRetryAt && selectedSymbol && selectedContractSymbol===null) {
      if(optionSelectionRetryMode==='AUTO' && optionSelectionRetrySymbol===selectedSymbol &&
         optionSelectionRetrySide===selectedOptionSide && document.querySelector('#expiry-select').value===optionSelectionRetryExpiry) {
        const retrySide=optionSelectionRetrySide;
        optionSelectionRetryAt=0; optionSelectionRetrySymbol=null; optionSelectionRetryMode='MANUAL';
        optionSelectionRetrySide=null; optionSelectionRetryExpiry=null;
        void autoSelectDirectionalOption(retrySide);
      } else if(optionSelectionRetryMode==='MANUAL' && optionSelectionRetrySymbol &&
                document.querySelector('#strike-select').value===optionSelectionRetrySymbol) {
        const retrySymbol=optionSelectionRetrySymbol;
        optionSelectionRetryAt=0; optionSelectionRetrySymbol=null;
        void selectOptionContract(retrySymbol);
      }
    }
    if(optionChainRetryAt && Date.now()>=optionChainRetryAt && selectedSymbol===optionChainRetrySymbol &&
       symbolSelectionGeneration===optionChainRetryGeneration && selectedUnderlyingPrice>0 && optionChainRows.length===0) {
      const retrySymbol=optionChainRetrySymbol, retryTimestamp=optionChainRetryTimestamp, retryGeneration=optionChainRetryGeneration;
      optionChainRetryAt=0; optionChainRetrySymbol=null; optionChainRetryTimestamp=''; optionChainRetryGeneration=0;
      void loadOptionChain(retrySymbol,selectedUnderlyingPrice,retryTimestamp,retryGeneration);
    }
    const selectedUnderlyingFresh=Boolean(underlyingTick?.fresh && underlyingTick.symbol===selectedSymbol);
    const selectedOptionFresh=Boolean(optionTick?.fresh && optionTick.symbol===selectedContractSymbol);
    if(!setupEvaluationDone && !setupEvaluationRunning && selectedUnderlyingFresh &&
       selectedOptionFresh &&
       selectedContractSymbol && Date.now()>=setupRetryAfter) {
      void evaluateSelectedSetup();
    }
    renderEntryEvaluationGate(md);

    const indices = md.indices || {};
    if (selectedSymbol && labels.some(([symbol]) => symbol === selectedSymbol)) {
      const indexTick = indices[selectedSymbol];
      chartLiveCandle = indexTick?.fresh ? indexTick.liveCandle || null : null;
      if (!chartGestureActive) renderChartViewport();
      renderLiveCandleSummary(indexTick || null);
      const candleStatus = document.querySelector('#chart-candle-status');
      if (candleStatus) candleStatus.textContent = indexTick?.fresh && chartLiveCandle
        ? 'INDEX LIVE CANDLE · FYERS EXCHANGE TICK FRESH'
        : 'INDEX HISTORY · WAITING FOR FRESH LIVE CANDLE';
    }
    const nseSessionOpen = isNseRegularSession(Date.now());
    let freshCount = 0;
    for (const [symbol, priceId, changeId, ageId] of labels) {
      const tick = indices[symbol];
      const price = document.getElementById(priceId);
      const change = document.getElementById(changeId);
      const age = document.getElementById(ageId);
      if (age) {
        const receiptAge = tick ? Math.max(0, Math.floor((Date.now() - Number(tick.receivedAt)) / 1000)) : null;
        const exchangeDelay = tick && Number.isFinite(Number(tick.exchangeReceiptDelayMs)) ? Math.round(Number(tick.exchangeReceiptDelayMs)) : null;
        age.textContent = !nseSessionOpen ? 'MARKET CLOSED' : tick?.fresh ? `FRESH ${receiptAge}s ago · EXCH→RX ${exchangeDelay}ms` : tick ? `STALE ${receiptAge}s ago · EXCH→RX ${exchangeDelay===null?'UNKNOWN':exchangeDelay+'ms'}` : 'NO TICK';
        age.dataset.state = tick?.fresh && nseSessionOpen ? 'fresh' : tick ? 'stale' : 'unknown';
      }
      if (nseSessionOpen && tick?.fresh) {
        freshCount++;
        price.textContent = showNumber(tick.price);
        const points = tick.change != null && Number.isFinite(Number(tick.change)) ? Number(tick.change) : null;
        const pct = tick.changePercent != null && Number.isFinite(Number(tick.changePercent)) ? Number(tick.changePercent) : null;
        const pointsText = points === null ? 'POINTS UNAVAILABLE' : (points >= 0 ? '+' : '') + showNumber(points) + ' pts';
        const pctText = pct === null ? 'CHANGE % UNAVAILABLE' : (pct >= 0 ? '+' : '') + pct.toFixed(2) + '%';
        change.textContent = pointsText + ' · ' + pctText;
        change.dataset.state = pct === null ? 'unknown' : pct > 0 ? 'up' : pct < 0 ? 'down' : 'flat';
        price.dataset.state = 'fresh';
      } else if (tick) {
        price.textContent = showNumber(tick.price);
        const points = tick.change != null && Number.isFinite(Number(tick.change)) ? Number(tick.change) : null;
        const pct = tick.changePercent != null && Number.isFinite(Number(tick.changePercent)) ? Number(tick.changePercent) : null;
        const pointsText = points === null ? 'POINTS UNAVAILABLE' : (points >= 0 ? '+' : '') + showNumber(points) + ' pts';
        const pctText = pct === null ? 'CHANGE % UNAVAILABLE' : (pct >= 0 ? '+' : '') + pct.toFixed(2) + '%';
        change.textContent = (nseSessionOpen ? 'STALE · ' : 'MARKET CLOSED · LAST SESSION · ') + pointsText + ' · ' + pctText;
        change.dataset.state = 'stale';
        price.dataset.state = 'stale';
      } else {
        price.textContent = '—';
        change.textContent = 'WAITING FOR FYERS TICK';
        change.dataset.state = 'unknown';
        price.dataset.state = 'unknown';
      }
    }
    const feed = document.querySelector('#feed');
    if (!nseSessionOpen) {
      feed.textContent = 'MARKET CLOSED · FYERS LAST PRICES · NOT LIVE';
      feed.dataset.state = 'stale';
    } else if (md.socketStatus === 'CONNECTED' && freshCount === 3) {
      feed.textContent = 'FYERS CONNECTED · 3/3 INDEX TICKS FRESH · NSE ONLY';
      feed.dataset.state = 'connected';
    } else if (md.socketStatus === 'CONNECTED' || md.socketStatus === 'CONNECTING' || freshCount > 0 || (s.auth?.tokenStored && !['ERROR','DISCONNECTED','SUBSCRIPTION_LIMIT_BLOCKED'].includes(md.socketStatus))) {
      feed.textContent = tickStatusText(md, freshCount);
      feed.dataset.state = 'stale';
    } else {
      feed.textContent = 'FYERS DISCONNECTED · NO VERIFIED LIVE TICK';
      feed.dataset.state = 'disconnected';
    }
    const ws = md.socketDiagnostics || {};
    const tickAge = ws.lastTickAgeSeconds !== null && ws.lastTickAgeSeconds !== undefined && Number.isFinite(Number(ws.lastTickAgeSeconds)) ? ws.lastTickAgeSeconds + 's AGO' : 'NEVER';
    const exchangeTickAge = ws.lastTickExchangeAgeSeconds !== null && ws.lastTickExchangeAgeSeconds !== undefined && Number.isFinite(Number(ws.lastTickExchangeAgeSeconds)) ? ws.lastTickExchangeAgeSeconds + 's' : 'UNKNOWN';
    feed.textContent += ' · WS ' + (md.socketStatus || 'UNKNOWN') +
      ' · RECONNECTS ' + (ws.reconnectCount || 0) +
      ' · CLOSES ' + (ws.closeCount || 0) +
      ' · ERRORS ' + (ws.errorCount || 0) +
      ' · LAST TICK RX ' + tickAge + ' · EXCHANGE AGE ' + exchangeTickAge;
    feed.title = 'WebSocket last connected: ' + (ws.lastConnectedAt || 'unknown') +
      ' · last closed: ' + (ws.lastClosedAt || 'unknown') +
      ' · last message: ' + (ws.lastMessageAt || 'unknown') +
      ' · last valid tick: ' + (ws.lastTickAt || 'unknown') +
      ' · last socket error: ' + (ws.lastErrorAt || 'none');
  } catch {
    document.querySelector('#feed').textContent = 'BACKEND DISCONNECTED';
    document.querySelector('#feed').dataset.state = 'disconnected';
  } finally {
    refreshRunning = false;
  }
}
restorePersistedChart();
let refreshTimer = null;
function startStatusPolling() {
  if (refreshTimer || document.hidden) return;
  void refresh();
  refreshTimer = setInterval(refresh, 2000);
}
function stopStatusPolling() {
  if (!refreshTimer) return;
  clearInterval(refreshTimer);
  refreshTimer = null;
}
document.addEventListener('visibilitychange', () => {
  if (document.hidden) stopStatusPolling();
  else startStatusPolling();
});
startStatusPolling();
if('serviceWorker' in navigator) window.addEventListener('load',()=>navigator.serviceWorker.register('/sw.js').catch(()=>{}));

function appendLine(container, text) {
  const line = document.createElement('div');
  line.className = 'account-line';
  line.textContent = text;
  container.append(line);
}
async function refreshAccount() {
  if (accountRefreshRunning) return;
  accountRefreshRunning = true;
  lastAccountRefresh = Date.now();
  const positionsEl = document.querySelector('#positions-data');
  const ordersEl = document.querySelector('#orders-data');
  const accountStatus = document.querySelector('#account-feed-status');
  if (accountStatus) accountStatus.textContent = 'CHECKING FYERS ACCOUNT FEED';
  try {
    const [positionsResponse, ordersResponse] = await Promise.all([
      fetch('/api/positions', { cache: 'no-store' }),
      fetch('/api/orderbook', { cache: 'no-store' })
    ]);
    const [positions, orders] = await Promise.all([
      positionsResponse.json(), ordersResponse.json()
    ]);
    positionsEl.replaceChildren();
    ordersEl.replaceChildren();
    if (accountStatus) {
      if (positionsResponse.ok && ordersResponse.ok) {
        accountStatus.textContent = 'FYERS ACCOUNT FEED · CONNECTED · READ-ONLY';
        accountStatus.dataset.state = 'connected';
      } else {
        const failed = !positionsResponse.ok ? positionsResponse : ordersResponse;
        accountStatus.textContent = failed.status === 429
          ? 'FYERS ACCOUNT FEED · RATE LIMITED'
          : failed.status === 401 || failed.status === 403
            ? 'FYERS ACCOUNT FEED · AUTHORIZATION REQUIRED'
            : 'FYERS ACCOUNT FEED · UNAVAILABLE · HTTP ' + failed.status;
        accountStatus.dataset.state = 'stale';
      }
    }
    if (!positionsResponse.ok) appendLine(positionsEl, positions.reason || 'FYERS positions are unavailable.');
    else {
      const rows = positions.netPositions || positions.data?.netPositions || [];
      const total = positions.overall?.pl;
      appendLine(positionsEl, `CURRENT-DAY POSITIONS · ${rows.length}`);
      if (Number.isFinite(Number(total))) appendLine(positionsEl, `Overall P&L: ₹${showNumber(total)}`);
      if (!rows.length) appendLine(positionsEl, 'No open or closed positions returned for today.');
      for (const row of rows.slice(0, 20)) {
        appendLine(positionsEl, `${row.symbol || 'Unknown'} · Net Qty ${showNumber(row.netQty,0)} · Avg ${showNumber(row.netAvg)} · P&L ₹${showNumber(row.pl)}`);
      }
    }
    if (!ordersResponse.ok) appendLine(ordersEl, orders.reason || 'FYERS orderbook is unavailable.');
    else {
      const rows = orders.orderBook || [];
      const statusNames = {1:'CANCELLED',2:'FILLED',4:'TRANSIT',5:'REJECTED',6:'PENDING',7:'EXPIRED'};
      appendLine(ordersEl, `TODAY’S ORDERS · ${rows.length} · READ-ONLY`);
      if (!rows.length) appendLine(ordersEl, 'No orders returned for today.');
      for (const row of rows.slice(0, 20)) {
        appendLine(ordersEl, `${row.symbol || 'Unknown'} · ${row.side === 1 ? 'BUY' : row.side === -1 ? 'SELL' : '—'} · ${statusNames[row.status] || 'STATUS ' + row.status} · Filled ${showNumber(row.filledQty,0)}/${showNumber(row.qty,0)}`);
      }
    }
  } catch {
    positionsEl.textContent = 'Account snapshot unavailable; no data is assumed.';
    ordersEl.textContent = 'Order status unavailable; no data is assumed.';
    if (accountStatus) {
      accountStatus.textContent = 'FYERS ACCOUNT FEED · REQUEST FAILED';
      accountStatus.dataset.state = 'stale';
    }
  } finally {
    accountRefreshRunning = false;
  }
}

function readTopGainersSnapshot() {
  try { return normalizeTopGainersSnapshot(JSON.parse(localStorage.getItem(TOP_GAINERS_SNAPSHOT_KEY) || 'null')); }
  catch { return null; }
}
function renderMovers(fno) {
  const container = document.querySelector('#movers');
  container.replaceChildren();
  const live = Array.isArray(fno.topGainers) ? fno.topGainers.slice(0, 5) : [];
  if (isNseRegularSession(Date.now()) && fno.status === 'ROTATING_LIVE_COVERAGE' && live.length && live.every(item => item?.fresh === true)) {
    try { localStorage.setItem(TOP_GAINERS_SNAPSHOT_KEY, JSON.stringify({ savedAt: Date.now(), items: live })); } catch {}
  }
  const snapshot = readTopGainersSnapshot();
  const view = resolveTopGainersView(fno, snapshot, Date.now());
  const top = view.items;
  const status = document.querySelector('#movers-status');
  if (view.mode === 'LIVE') {
    const coverageText = (fno.observedCount ?? 0) + '/' + fno.universeCount + ' OBSERVED';
    status.textContent = (fno.coverageComplete ? 'ROLLING FULL-UNIVERSE · ' : 'ROLLING PARTIAL · ') + coverageText + ' · ' + (fno.freshCount ?? 0) + ' FRESH · ' + Math.round((fno.rotationIntervalMs || 60000) / 1000) + 's/SLICE · NON-SIMULTANEOUS · ' + fno.subscriptionCount + '/100 SYMBOLS';
  } else if (view.mode === 'LAST_SESSION') {
    status.textContent = 'MARKET CLOSED · LAST SESSION TOP 5 · NOT LIVE';
  } else if (view.mode === 'LAST_OBSERVED') {
    status.textContent = 'FYERS FEED STALE / DISCONNECTED · LAST OBSERVED TOP 5 · NOT LIVE';
  } else {
    const labels = { SYMBOL_MASTER_NOT_LOADED: 'SYMBOL MASTER NOT READY', SOCKET_ERROR: 'FYERS SOCKET ERROR', WAITING_FOR_FNO_TICKS: 'WAITING FOR F&O TICKS' };
    status.textContent = labels[fno.status] || (view.mode === 'MARKET_CLOSED_NO_SNAPSHOT' ? 'MARKET CLOSED · NO SAVED SESSION SNAPSHOT' : 'F&O FEED PENDING');
  }
  if (!top.length) {
    const note = document.createElement('div');
    note.className = 'empty-inline';
    note.textContent = view.mode === 'MARKET_CLOSED_NO_SNAPSHOT'
      ? 'No verified Top 5 snapshot was saved during the last session. No sample gainers are shown.'
      : fno.status === 'SYMBOL_MASTER_NOT_LOADED'
        ? 'Official FYERS NSE F&O symbol master is not loaded. No sample gainers are shown.'
        : fno.status === 'SOCKET_ERROR'
          ? 'FYERS rejected or closed the F&O subscription. ' + (fno.lastError || 'Socket error detail unavailable.')
          : 'Waiting for fresh exchange-timestamped F&O underlying ticks. No sample gainers are shown.';
    container.append(note);
    return;
  }
  top.slice(0, 5).forEach((item, index) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'mover-card';
    const pct = Number(item.changePercent);
    const direction = pct > 0 ? 'up' : pct < 0 ? 'down' : 'flat';
    const cardState = view.mode === 'LIVE' && item.fresh ? direction : 'stale';
    button.dataset.state = cardState;
    button.dataset.rank = String(index + 1);
    button.title = view.mode === 'LIVE' && item.fresh ? 'Fresh FYERS exchange tick · ' + direction.toUpperCase() + ' ' + pct.toFixed(2) + '%' : (view.mode === 'LIVE' ? 'Rolling FYERS session observation · ' + Number(item.ageSeconds).toFixed(0) + 's old · NOT ACTIONABLE' : (view.mode === 'LAST_SESSION' ? 'LAST SESSION SNAPSHOT · NOT LIVE OR ACTIONABLE' : 'LAST OBSERVED SNAPSHOT · NOT LIVE OR ACTIONABLE'));
    button.addEventListener('click', () => selectUserSymbol(item.symbol, item.price));
    const name = document.createElement('strong');
    name.textContent = item.symbol.replace(/^NSE:/, '').replace(/-EQ$/, '');
    const price = document.createElement('span');
    price.textContent = `₹${showNumber(item.price)}`;
    const change = document.createElement('span');
    change.textContent = (pct >= 0 ? '+' : '') + pct.toFixed(2) + '% · ' + (view.mode === 'LIVE' && item.fresh ? 'FRESH' : view.mode === 'LIVE' ? 'OBSERVED ' + Number(item.ageSeconds).toFixed(0) + 's · NOT ACTIONABLE' : view.mode === 'LAST_SESSION' ? 'LAST SESSION' : 'LAST OBSERVED · NOT LIVE');
    change.dataset.state = view.mode === 'LIVE' && item.fresh ? direction : 'stale';
    button.append(name, price, change);
    container.append(button);
  });
}
async function selectIndexSymbol(symbol) {
  userSelectedSymbol=true;chartViewGeneration++;chartViewMode='UNDERLYING';chartViewSymbol=null;
  if (!['NSE:NIFTY50-INDEX','NSE:NIFTYBANK-INDEX','NSE:FINNIFTY-INDEX'].includes(symbol)) return;
  selectedSymbol = symbol; researchContextReadySymbol = null; researchContextRetryAt = 0; resetChartViewport(); selectedUnderlyingPrice = null; selectedContractSymbol = null; chartSetupLevels = null; setupOptionTrigger = null; setupRetryAfter = 0;
  setupEvaluationDone = true; setupEvaluationRunning = false; chartLiveCandle = null; chartCandles = [];
  const title=document.querySelector('#symbol'),area=document.querySelector('#chart-area');
  title.textContent=symbol+' · LOADING VERIFIED FYERS INDEX HISTORY';
  area.replaceChildren();
  const loading=document.createElement('div');loading.className='chart-empty';
  loading.textContent='Loading completed FYERS index candles. No synthetic candles are used.';area.append(loading);
  for(const id of ['setup-entry','setup-sl','setup-target','setup-rr'])document.getElementById(id).textContent='—';
  document.querySelector('#setup-state').textContent='INDEX CHART · OPTIONS STRATEGY NOT APPLICABLE';
  document.querySelector('#option-status').textContent='INDEX SELECTED · OPTION CHAIN NOT APPLICABLE';
  document.querySelector('#option-ltp').textContent='—';document.querySelector('#option-quantity').textContent='—';
  document.querySelector('#expiry-select').replaceChildren(new Option('—',''));
  document.querySelector('#strike-select').replaceChildren(new Option('—',''));
  document.querySelector('#research-status').textContent='INDEX VIEW · STOCK SETUP RESEARCH NOT RUN';
  document.querySelector('#research-results').textContent='Select an NSE F&O gainer to run the nine-strategy research engine.';
  renderLiveCandleSummary(null);
  try {
    await clearSelectedOption();
    const response=await fetch('/api/history?symbol='+encodeURIComponent(symbol),{cache:'no-store'});
    const data=await response.json();
    if(!response.ok||!Array.isArray(data.candles)||!data.candles.length)throw new Error(data.reason||'Verified FYERS index history unavailable');
    if(selectedSymbol!==symbol)return;
    drawHistoryChart(data.candles);selectedUnderlyingPrice=Number(data.candles.at(-1)?.close)||null;
    title.textContent=`${symbol} · FYERS HISTORY · ${data.count} COMPLETED 5-MIN INDEX CANDLES`;
    document.querySelector('#chart-candle-status').textContent='INDEX HISTORY · COMPLETED FYERS CANDLES';
  } catch(error) {
    if(selectedSymbol!==symbol)return;
    area.replaceChildren();const note=document.createElement('div');note.className='chart-empty';
    note.textContent=String(error.message||'Index history unavailable')+' · NO SYNTHETIC DATA';
    area.append(note);title.textContent=symbol+' · INDEX HISTORY UNAVAILABLE';
  }
}
async function readJsonResponse(response, endpoint) {
  try {
    return await response.json();
  } catch {
    const contentType = response.headers.get('content-type') || 'content-type missing';
    throw new Error(endpoint + ' returned non-JSON response · HTTP ' + response.status + ' · ' + contentType);
  }
}
async function ensureResearchContext(symbol) {
  if (!symbol) return;
  // Index charts do not require equity 15m/5m trend context context. Mark them
  // ready locally rather than repeatedly requesting an endpoint that correctly
  // accepts only official NSE F&O underlyings.
  if (labels.some(([indexSymbol]) => indexSymbol === symbol)) {
    researchContextReadySymbol = symbol;
    return;
  }
  if (researchContextReadySymbol === symbol || Date.now() < researchContextRetryAt) return;
  if (researchContextLoadingSymbol === symbol && researchContextLoadingPromise) return researchContextLoadingPromise;
  researchContextLoadingSymbol = symbol;
  const pending = (async () => {
    try {
      const response = await fetch('/api/research-context?symbol=' + encodeURIComponent(symbol), { cache: 'no-store' });
      const payload = await readJsonResponse(response, 'RESEARCH CONTEXT /api/research-context');
      if (!response.ok) throw new Error(payload.reason || 'Research context request failed · HTTP ' + response.status);
      if (selectedSymbol === symbol) {
        researchContextReadySymbol = symbol;
        researchContextRetryAt = 0;
      }
    } catch (error) {
      if (selectedSymbol === symbol) {
        researchContextRetryAt = Date.now() + 15_000;
        document.querySelector('#research-status').textContent = 'RESEARCH CONTEXT WAITING · NO TRADE';
      }
      throw error;
    }
  })();
  researchContextLoadingPromise = pending;
  try {
    await pending;
  } finally {
    if (researchContextLoadingSymbol === symbol && researchContextLoadingPromise === pending) {
      researchContextLoadingSymbol = null;
      researchContextLoadingPromise = null;
    }
  }
}
async function selectSymbol(symbol, livePrice = null) {
  if (!symbol) return;
  if(symbol===selectedSymbol&&!chartRestoredFromCache&&chartViewMode==='UNDERLYING') return;
  chartViewGeneration++;chartViewMode='UNDERLYING';chartViewSymbol=null;
  // A persisted chart is display-only. Selecting that same symbol must still
  // fetch current verified FYERS history; never let a cache hit suppress reload.
  const selectionGeneration = ++symbolSelectionGeneration;
  optionSelectionGeneration++;
  selectedSymbol = symbol;
  selectedContractSymbol = null;
  optionChainRows = [];
  selectedUnderlyingPrice = null;
  researchContextReadySymbol = null;
  researchContextRetryAt = 0;
  chartRestoredFromCache = false;
  resetChartViewport();
  setupOptionTrigger = null; setupRetryAfter = 0;
  optionSelectionRetryAt=0; optionSelectionRetrySymbol=null; optionSelectionRetryMode='MANUAL'; optionSelectionRetrySide=null; optionSelectionRetryExpiry=null;
  optionChainRetryAt=0; optionChainRetrySymbol=null; optionChainRetryTimestamp=''; optionChainRetryGeneration=0;
  chartSetupLevels = null;
  setupEvaluationDone = false;
  setupEvaluationRunning = false;
  chartLiveCandle = null;
  // A prior index selection must not leave index-only labels visible while a
  // stock is loading. Reset every dependent panel immediately on symbol change.
  document.querySelector('#setup-state').textContent = 'STOCK SELECTED · VERIFYING LIVE DATA';
  document.querySelector('#setup-state').dataset.state = 'blocked';
  document.querySelector('#chart-candle-status').textContent = 'COMPLETED STOCK CANDLES · LIVE CANDLE VERIFYING';
  document.querySelector('#research-status').textContent = 'STOCK RESEARCH · LOADING VERIFIED CONTEXT';
  document.querySelector('#research-results').textContent = 'Research ranking warms separately. Live setup checks use each strategy’s own verified price rules.';
  document.querySelector('#option-status').textContent = 'LOADING VERIFIED FYERS OPTION CHAIN';
  document.querySelector('#option-ltp').textContent = 'WAITING FOR LIVE OPTION TICK';
  document.querySelector('#option-quantity').textContent = '—';
  document.querySelector('#strike-select').replaceChildren(new Option('WAITING FOR VERIFIED CONTRACTS',''));
  const title = document.querySelector('#symbol');
  const area = document.querySelector('#chart-area');
  title.textContent = symbol + ' · LOADING VERIFIED FYERS HISTORY';
  area.replaceChildren();
  const loading = document.createElement('div');
  loading.className = 'chart-empty';
  loading.textContent = 'Loading completed FYERS 5-minute candles. No synthetic candles are used.';
  area.append(loading);

  let data;
  let socketPinError = null;
  try {
    const selectionResponse = await fetch('/api/select-underlying',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({symbol})});
    const selection = await readJsonResponse(selectionResponse, 'FYERS UNDERLYING SELECTION');
    if (!selectionResponse.ok || !['UNDERLYING_PINNED_TO_SOCKET_SLICE','UNCHANGED'].includes(selection.status)) {
      throw new Error(selection.reason || 'Underlying socket subscription was not confirmed');
    }
    if (selectedSymbol !== symbol || selectionGeneration !== symbolSelectionGeneration) return;
  } catch (error) {
    // Live socket pinning is required for fresh-tick trading gates, not for
    // independently verified historical candles. Keep the chart available
    // while clearly marking the live feed as unavailable and NO TRADE.
    socketPinError = String(error.message || 'Underlying socket subscription was not confirmed');
  }
  if (selectedSymbol !== symbol || selectionGeneration !== symbolSelectionGeneration) return;

  try {
    const response = await fetch('/api/history?symbol=' + encodeURIComponent(symbol), { cache: 'no-store' });
    data = await readJsonResponse(response, 'FYERS HISTORY /api/history');
    if (!response.ok || !Array.isArray(data.candles) || !data.candles.length) {
      throw new Error(data.reason || 'Verified FYERS history is unavailable');
    }
    if (selectedSymbol !== symbol || selectionGeneration !== symbolSelectionGeneration) return;

    drawHistoryChart(data.candles);
    selectedUnderlyingPrice = Number(livePrice) > 0 ? Number(livePrice) : (Number(data.candles.at(-1)?.close) || null);
    title.textContent = symbol + ' · FYERS HISTORY · ' + (data.count ?? data.candles.length) + ' COMPLETED 5-MIN CANDLES' + (socketPinError ? ' · LIVE FEED UNAVAILABLE · NO TRADE' : '');
  } catch (error) {
    if (selectedSymbol !== symbol || selectionGeneration !== symbolSelectionGeneration) return;
    area.replaceChildren();
    const note = document.createElement('div');
    note.className = 'chart-empty';
    note.textContent = String(error.message || 'History unavailable') + ' · NO TRADE';
    area.append(note);
    title.textContent = symbol + ' · HISTORY UNAVAILABLE';
    return;
  }

  // Option selection is downstream of the chart. Its failure must never erase
  // verified underlying history or change the chart's availability status.
  try {
    if (selectedSymbol !== symbol || selectionGeneration !== symbolSelectionGeneration) return;
    // The backend atomically clears any prior option when the underlying changes.
    // Keep the user-facing option-chain request ahead of 15m/5m trend context warmup.
    await loadOptionChain(symbol, selectedUnderlyingPrice, '', selectionGeneration);
  } catch (error) {
    if (selectedSymbol !== symbol) return;
    document.querySelector('#option-status').textContent =
      'OPTION CHAIN UNAVAILABLE · ' + String(error.message || 'No verified contracts');
  }

  // Research is an independent panel: malformed/HTML responses are diagnosed
  // there, while the already-rendered history chart remains intact.
  try {
    await ensureResearchContext(symbol);
    if (selectedSymbol !== symbol || selectionGeneration !== symbolSelectionGeneration || researchContextReadySymbol !== symbol) return;
    const researchResponse = await fetch('/api/research?symbol=' + encodeURIComponent(symbol), { cache: 'no-store' });
    const researchPayload = await readJsonResponse(researchResponse, 'RESEARCH /api/research');
    if (selectedSymbol !== symbol || selectionGeneration !== symbolSelectionGeneration) return;
    if (!researchResponse.ok) throw new Error(researchPayload.reason || 'Research request failed · HTTP ' + researchResponse.status);
    renderResearchResults(researchPayload);
  } catch (error) {
    if (selectedSymbol !== symbol || selectionGeneration !== symbolSelectionGeneration) return;
    document.querySelector('#research-status').textContent = 'RESEARCH UNAVAILABLE · NO TRADE';
    const results = document.querySelector('#research-results');
    results.replaceChildren();
    const note = document.createElement('div');
    note.className = 'empty-inline';
    note.textContent = String(error.message || 'Research data unavailable') + '. Verified chart history is retained; no setup is inferred.';
    results.append(note);
  }
}
function selectUserSymbol(symbol, livePrice=null) {
  userSelectedSymbol=true;
  return selectSymbol(symbol,livePrice);
}

function drawHistoryChart(candles) {
  chartCandles = Array.isArray(candles) ? candles.slice() : [];
  // Keep the default viewport focused on current-session price action; users can zoom out for history.
  chartZoom = Math.max(1, chartCandles.length / 75);
  chartPan = 0;
  if(chartViewMode==='UNDERLYING') {
    try {
      const snapshot = normalizeChartSnapshot({ symbol: selectedSymbol, savedAt: Date.now(), candles: chartCandles });
      if (snapshot) localStorage.setItem(CHART_SNAPSHOT_KEY, JSON.stringify(snapshot));
    } catch {}
  }
  renderChartViewport();
}
function restorePersistedChart() {
  try {
    const snapshot = normalizeChartSnapshot(JSON.parse(localStorage.getItem(CHART_SNAPSHOT_KEY) || 'null'));
    if (!snapshot) return;
    selectedSymbol = snapshot.symbol;
    chartCandles = snapshot.candles;
    // Cached history also opens on the most recent, readable session view.
    chartZoom = Math.max(1, chartCandles.length / 75);
    chartPan = 0;
    chartRestoredFromCache = true;
    const title = document.querySelector('#symbol');
    if (title) title.textContent = selectedSymbol + ' · LAST 10 SESSIONS VERIFIED FYERS HISTORY · NOT LIVE';
    const candleStatus = document.querySelector('#chart-candle-status');
    if (candleStatus) candleStatus.textContent = 'LAST SESSION · VERIFIED FYERS 5-MIN CANDLES · NOT LIVE';
    renderChartViewport();
    renderLiveCandleSummary(null);
    // A persisted chart is display-only. Re-pin its symbol to this server
    // process immediately; waiting for a matching backend tick here deadlocks
    // after a Render restart because the backend cannot emit that tick until
    // the selected underlying has been pinned to the WebSocket slice.
    void selectSymbol(snapshot.symbol);
  } catch {}
}
function renderLiveCandleSummary(tick) {
  const panel = document.querySelector('#live-candle-summary');
  if (!panel) return;
  panel.replaceChildren();
  const heading = document.createElement('strong');
  heading.textContent = 'LIVE 5-MIN CANDLE';
  const fresh = Boolean(tick?.fresh && tick.symbol === selectedSymbol && chartLiveCandle);
  const state = document.createElement('span');
  state.className = 'live-candle-state';
  state.dataset.state = fresh ? 'fresh' : 'stale';
  state.textContent = fresh ? 'FRESH FYERS TICK' : 'WAITING FOR FRESH FYERS TICK';
  panel.append(heading, state);
  if (!chartLiveCandle || chartLiveCandle.time <= 0) return;
  const c = chartLiveCandle;
  const time = new Date((Number(c.time) + 19800) * 1000).toISOString().slice(0,16).replace('T',' ');
  const fields = [
    ['TIME', time + '–' + new Date((Number(c.time) + 19800 + 300) * 1000).toISOString().slice(11,16) + ' IST'],
    ['LIVE PRICE', fresh ? '₹' + showNumber(tick.price) : '—'],
    ['OPEN', showNumber(c.open)],
    ['HIGH', showNumber(c.high)],
    ['LOW', showNumber(c.low)],
    ['CLOSE', showNumber(c.close)],
    ['VOLUME', showNumber(c.volume, 0)]
  ];
  for (const [label, value] of fields) {
    const item = document.createElement('div');
    item.className = 'live-candle-metric';
    const name = document.createElement('small');
    name.textContent = label;
    const number = document.createElement('b');
    number.textContent = value;
    item.append(name, number);
    panel.append(item);
  }
}
function resetChartViewport() {
  chartZoom = Math.max(1, chartCandles.length / 75);
  chartPan = 0; chartPriceZoom = 1; chartFollowLive = true;
}
function ensureChartControls(area) {
  if (!area?.parentElement) return;
  let controls = area.parentElement.querySelector('[data-chart-controls]');
  if (!controls) {
    controls = document.createElement('div');
    controls.dataset.chartControls = 'true';
    controls.setAttribute('aria-label', 'Chart navigation controls');
    controls.style.cssText = 'display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin:0 0 9px;';
    const makeButton = (label, title, action) => {
      const button = document.createElement('button');
      button.type = 'button'; button.textContent = label; button.title = title;
      button.style.cssText = 'border:1px solid #3b506d;border-radius:7px;background:#13243a;color:#dceaff;padding:8px 12px;font-size:11px;font-weight:800;cursor:pointer;min-height:34px;';
      button.addEventListener('click', action);
      controls.append(button);
      return button;
    };
    const zoomOut = makeButton('−', 'Zoom out', () => { chartZoom = Math.max(1, chartZoom / 1.2); renderChartViewport(); });
    zoomOut.setAttribute('aria-label', 'Zoom out');
    const zoomIn = makeButton('+', 'Zoom in', () => { chartZoom = Math.min(Math.max(1, chartCandles.length / 8), chartZoom * 1.2); renderChartViewport(); });
    zoomIn.setAttribute('aria-label', 'Zoom in');
    const follow = makeButton('LIVE FOLLOW · ON', 'Keep the latest verified FYERS candle in view', () => {
      chartFollowLive = !chartFollowLive;
      if (chartFollowLive) chartPan = 0;
      renderChartViewport();
    });
    follow.dataset.followButton = 'true';
    const reset = makeButton('RESET VIEW', 'Reset zoom and return to the latest candles', () => {
      resetChartViewport(); renderChartViewport();
    });
    reset.dataset.resetButton = 'true';
    area.parentElement.insertBefore(controls, area);
  }
  const follow = controls.querySelector('[data-follow-button]');
  if (follow) {
    follow.textContent = chartFollowLive ? 'LIVE FOLLOW · ON' : 'LIVE FOLLOW · OFF';
    follow.setAttribute('aria-pressed', String(chartFollowLive));
    follow.style.borderColor = chartFollowLive ? '#168b75' : '#3b506d';
    follow.style.color = chartFollowLive ? '#8cf0d4' : '#dceaff';
  }
}
function renderChartViewport() {
  const area = document.querySelector('#chart-area');
  // Never replace the loading/error state with a live-only chart. A live tick is
  // not a substitute for verified completed FYERS history, especially on indices.
  if (!chartCandles.length) return;
  ensureChartControls(area);
  const candles = chartLiveCandle && chartLiveCandle.time > 0 ? [...chartCandles, chartLiveCandle] : chartCandles;
  area.replaceChildren();
  if (!candles.length) return;
  if (chartFollowLive) chartPan = 0;
  const visibleCount = Math.max(8, Math.min(candles.length, Math.ceil(candles.length / chartZoom)));
  const maxPan = Math.max(0, candles.length - visibleCount);
  chartPan = Math.max(0, Math.min(maxPan, chartPan));
  const startIndex = Math.max(0, candles.length - visibleCount - Math.round(chartPan));
  const visible = candles.slice(startIndex, startIndex + visibleCount);
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', '0 0 1200 620');
  svg.setAttribute('role', 'img');
  svg.setAttribute('aria-label', 'FYERS completed five-minute candlestick chart with supply and demand structure zones');
  svg.setAttribute('preserveAspectRatio', 'none');
  svg.style.touchAction = 'none';
  svg.style.userSelect = 'none';
  svg.style.webkitUserSelect = 'none';
  const chartSymbolLabel = (chartViewSymbol || selectedSymbol || 'SELECT SYMBOL')
    .replace(/^(NSE|BSE):/, '')
    .replace(/-EQ$/, '')
    .replace('-INDEX', '')
    .replace('NIFTY50', 'NIFTY 50')
    .replace('NIFTYBANK', 'BANK NIFTY');
  svg.setAttribute('aria-label', chartSymbolLabel + ' FYERS five-minute candlestick chart with supply and demand structure zones');
  const left=76,right=92,top=chartSetupLevels?118:28,bottom=100,plotW=1200-left-right,plotH=620-top-bottom;
  const highs=visible.map(c=>Number(c.high)), lows=visible.map(c=>Number(c.low));
  const max=Math.max(...highs),min=Math.min(...lows),range=Math.max(max-min,0.000001);
  const pad=range*.08, center=(max+min)/2, span=(range+pad*2)/chartPriceZoom, ceiling=center+span/2, floor=center-span/2;
  const y=p=>top+(ceiling-p)/span*plotH;
  const xStep=plotW/visible.length, xAt=i=>left+xStep*(i+.5);
  for(let i=0;i<=4;i++){
    const price=ceiling-span*i/4, gy=y(price);
    const grid=document.createElementNS(ns,'line');
    grid.setAttribute('x1',left);grid.setAttribute('x2',left+plotW);grid.setAttribute('y1',gy);grid.setAttribute('y2',gy);
    grid.setAttribute('stroke','#26364d');grid.setAttribute('stroke-width','1');svg.append(grid);
    const label=document.createElementNS(ns,'text');
    label.setAttribute('x',left+plotW+12);label.setAttribute('y',gy+5);label.setAttribute('fill','#9bb0ca');label.setAttribute('font-size','14');
    label.textContent=showNumber(price);svg.append(label);
  }
  // Show a separate live-price guide only when the existing verified FYERS live candle is available.
  if (chartLiveCandle && visible.some(c=>c.time===chartLiveCandle.time)) {
    const livePrice=Number(chartLiveCandle.close);
    if (Number.isFinite(livePrice) && livePrice>0) {
      const liveY=y(livePrice);
      const liveLine=document.createElementNS(ns,'line');
      liveLine.setAttribute('x1',left);liveLine.setAttribute('x2',left+plotW);
      liveLine.setAttribute('y1',liveY);liveLine.setAttribute('y2',liveY);
      liveLine.setAttribute('stroke','#7bd8ff');liveLine.setAttribute('stroke-width','1.8');
      liveLine.setAttribute('stroke-dasharray','7 4');liveLine.setAttribute('opacity','.95');svg.append(liveLine);
      const liveLabel=document.createElementNS(ns,'text');
      liveLabel.setAttribute('x',left+plotW+10);liveLabel.setAttribute('y',liveY-7);
      liveLabel.setAttribute('fill','#7bd8ff');liveLabel.setAttribute('font-size','13');
      liveLabel.setAttribute('font-weight','900');liveLabel.textContent='LIVE '+showNumber(livePrice);svg.append(liveLabel);
    }
  }
  // Demand/supply are drawn only from confirmed local pivot candles in the visible completed history.
  const pivots=[];
  for(let i=2;i<visible.length-2;i++){
    const c=visible[i],lo=Number(c.low),hi=Number(c.high);
    const isDemand=visible.slice(i-2,i).every(v=>Number(v.low)>=lo)&&visible.slice(i+1,i+3).every(v=>Number(v.low)>lo);
    const isSupply=visible.slice(i-2,i).every(v=>Number(v.high)<=hi)&&visible.slice(i+1,i+3).every(v=>Number(v.high)<hi);
    if(isDemand)pivots.push({kind:'DEMAND',index:i,low:lo,high:Math.min(Number(c.open),Number(c.close))});
    if(isSupply)pivots.push({kind:'SUPPLY',index:i,low:Math.max(Number(c.open),Number(c.close)),high:hi});
  }
  const latestDemand=[...pivots].reverse().find(p=>p.kind==='DEMAND');
  const latestSupply=[...pivots].reverse().find(p=>p.kind==='SUPPLY');
  for(const zone of [latestDemand,latestSupply].filter(Boolean)){
    const rect=document.createElementNS(ns,'rect');
    rect.setAttribute('x',left+xStep*zone.index);rect.setAttribute('width',Math.max(22,plotW*.18));
    rect.setAttribute('y',y(zone.high));rect.setAttribute('height',Math.max(3,y(zone.low)-y(zone.high)));
    rect.setAttribute('fill',zone.kind==='DEMAND'?'#16c784':'#ea3943');rect.setAttribute('fill-opacity','.14');
    rect.setAttribute('stroke',zone.kind==='DEMAND'?'#16c784':'#ea3943');rect.setAttribute('stroke-opacity','.75');rect.setAttribute('stroke-dasharray','5 4');
    svg.append(rect);
    const tag=document.createElementNS(ns,'text');tag.setAttribute('x',left+plotW-5);tag.setAttribute('y',y((zone.high+zone.low)/2)-5);
    tag.setAttribute('text-anchor','end');tag.setAttribute('font-size','13');tag.setAttribute('font-weight','700');tag.setAttribute('fill',zone.kind==='DEMAND'?'#35d99a':'#ff737c');
    tag.textContent=zone.kind+' ZONE';svg.append(tag);
  }
  visible.forEach((c,i)=>{
    const x=xAt(i),isLive=Boolean(chartLiveCandle && c.time===chartLiveCandle.time);
    const up=Number(c.close)>=Number(c.open),color=up?'#32c48d':'#ef6b73';
    if(isLive){
      const guide=document.createElementNS(ns,'line');
      guide.setAttribute('x1',x);guide.setAttribute('x2',x);guide.setAttribute('y1',top);guide.setAttribute('y2',top+plotH);
      guide.setAttribute('stroke','#55c8ff');guide.setAttribute('stroke-width','2');guide.setAttribute('stroke-dasharray','7 6');guide.setAttribute('opacity','.85');svg.append(guide);
    }
    const wick=document.createElementNS(ns,'line');wick.setAttribute('x1',x);wick.setAttribute('x2',x);wick.setAttribute('y1',y(Number(c.high)));wick.setAttribute('y2',y(Number(c.low)));wick.setAttribute('stroke',isLive?'#7bd8ff':color);wick.setAttribute('stroke-width',isLive?'4':String(Math.max(1,xStep*.12)));
    const body=document.createElementNS(ns,'rect'),bodyTop=y(Math.max(Number(c.open),Number(c.close))),bodyBottom=y(Math.min(Number(c.open),Number(c.close)));
    body.setAttribute('x',x-Math.max(isLive?6:.5,xStep*(isLive?.39:.29)));body.setAttribute('y',bodyTop);body.setAttribute('width',Math.max(isLive?12:1,xStep*(isLive?.78:.58)));body.setAttribute('height',Math.max(3,bodyBottom-bodyTop));body.setAttribute('fill',color);
    if(isLive){body.setAttribute('stroke','#d8f5ff');body.setAttribute('stroke-width','2');body.setAttribute('filter','drop-shadow(0 0 7px #43bdff)');}
    const title=document.createElementNS(ns,'title');
    title.textContent=(isLive?'LIVE · ':'')+new Date((Number(c.time)+19800)*1000).toISOString().slice(0,16).replace('T',' ')+' IST · O '+showNumber(c.open)+' H '+showNumber(c.high)+' L '+showNumber(c.low)+' C '+showNumber(c.close)+' · Vol '+showNumber(c.volume,0);
    body.append(title);svg.append(wick,body);
    if(isLive){
      const tag=document.createElementNS(ns,'text');tag.setAttribute('x',x);tag.setAttribute('y',top+18);tag.setAttribute('text-anchor','middle');tag.setAttribute('font-size','15');tag.setAttribute('font-weight','900');tag.setAttribute('fill','#7bd8ff');tag.textContent='LIVE';svg.append(tag);
    }
  });
  // These levels are option-premium prices, not underlying-share prices.
  // Show a dedicated arrow lane above the underlying chart to avoid mixing scales.
  if (chartSetupLevels) {
    const markers = [
      { label: 'OPTION ENTRY', value: chartSetupLevels.entry, color: '#4c9aff' },
      { label: 'OPTION STOP LOSS', value: chartSetupLevels.stopLoss, color: '#ea3943' },
      { label: 'OPTION TARGET', value: chartSetupLevels.target, color: '#16c784' }
    ];
    markers.forEach((item, index) => {
      const yy = 36 + index * 28;
      const line = document.createElementNS(ns, 'line');
      line.setAttribute('x1', left + 4); line.setAttribute('x2', left + plotW - 5);
      line.setAttribute('y1', yy); line.setAttribute('y2', yy);
      line.setAttribute('stroke', item.color); line.setAttribute('stroke-width', '2.5');
      line.setAttribute('stroke-dasharray', index === 0 ? 'none' : '8 5');
      line.setAttribute('opacity', '.95'); svg.append(line);
      const arrow = document.createElementNS(ns, 'path');
      arrow.setAttribute('d', 'M ' + (left + plotW - 15) + ' ' + (yy - 8) + ' L ' + (left + plotW - 4) + ' ' + yy + ' L ' + (left + plotW - 15) + ' ' + (yy + 8));
      arrow.setAttribute('fill', 'none'); arrow.setAttribute('stroke', item.color);
      arrow.setAttribute('stroke-width', '3'); arrow.setAttribute('stroke-linecap', 'round');
      arrow.setAttribute('stroke-linejoin', 'round'); svg.append(arrow);
      const bg = document.createElementNS(ns, 'rect');
      bg.setAttribute('x', left + 12); bg.setAttribute('y', yy - 11);
      bg.setAttribute('width', 210); bg.setAttribute('height', 22);
      bg.setAttribute('rx', 5); bg.setAttribute('fill', '#091522');
      bg.setAttribute('stroke', item.color); bg.setAttribute('stroke-width', '1'); svg.append(bg);
      const label = document.createElementNS(ns, 'text');
      label.setAttribute('x', left + 20); label.setAttribute('y', yy + 4);
      label.setAttribute('fill', item.color); label.setAttribute('font-size', '12');
      label.setAttribute('font-weight', '900');
      label.textContent = item.label + '  ₹' + showNumber(item.value); svg.append(label);
    });
  }
  // Day-wise partitions use the exchange's IST calendar date. Every candle's
  // native SVG tooltip carries its exact YYYY-MM-DD HH:mm IST timestamp.
  const dayGroups=[];
  visible.forEach((c,index)=>{
    const date=new Date((Number(c.time)+19800)*1000).toISOString().slice(0,10);
    const last=dayGroups[dayGroups.length-1];
    if(!last||last.date!==date)dayGroups.push({date,start:index,end:index});
    else last.end=index;
  });
  dayGroups.forEach((day,index)=>{
    const xStart=left+xStep*day.start,xEnd=left+xStep*(day.end+1);
    if(index>0){
      const divider=document.createElementNS(ns,'line');
      divider.setAttribute('x1',xStart);divider.setAttribute('x2',xStart);
      divider.setAttribute('y1',top);divider.setAttribute('y2',top+plotH+38);
      divider.setAttribute('stroke','#7890ad');divider.setAttribute('stroke-width','1.5');
      divider.setAttribute('stroke-dasharray','5 5');divider.setAttribute('opacity','.7');svg.append(divider);
    }
    const label=document.createElementNS(ns,'text');
    label.setAttribute('x',(xStart+xEnd)/2);label.setAttribute('y',568);
    label.setAttribute('text-anchor','middle');label.setAttribute('fill','#d3e0f2');
    label.setAttribute('font-size','12');label.setAttribute('font-weight','800');
    label.textContent=new Date(day.date+'T00:00:00Z').toLocaleDateString('en-IN',{day:'2-digit',month:'short',timeZone:'UTC'})+' · '+(day.end-day.start+1)+'×5m';
    svg.append(label);
  });
  const timeAxis=document.createElementNS(ns,'text');
  timeAxis.setAttribute('x',left);timeAxis.setAttribute('y',594);
  timeAxis.setAttribute('fill','#8fa6c2');timeAxis.setAttribute('font-size','11');
  timeAxis.textContent='IST · 09:15 OPEN → 15:25 LAST 5-MIN BAR · HOVER / TAP A CANDLE FOR EXACT DATE & TIME';
  svg.append(timeAxis);
  const crossV=document.createElementNS(ns,'line');crossV.setAttribute('id','chart-crosshair-v');crossV.setAttribute('y1',top);crossV.setAttribute('y2',top+plotH);crossV.setAttribute('stroke','#c6d4e6');crossV.setAttribute('stroke-dasharray','4 5');crossV.setAttribute('opacity','0');
  const crossH=document.createElementNS(ns,'line');crossH.setAttribute('id','chart-crosshair-h');crossH.setAttribute('x1',left);crossH.setAttribute('x2',left+plotW);crossH.setAttribute('stroke','#c6d4e6');crossH.setAttribute('stroke-dasharray','4 5');crossH.setAttribute('opacity','0');
  svg.append(crossV,crossH);
  const info=document.createElementNS(ns,'text');info.setAttribute('id','chart-crosshair-info');info.setAttribute('x',left+8);info.setAttribute('y',18);info.setAttribute('fill','#dceaff');info.setAttribute('font-size','14');info.textContent='Move over chart for candle time and OHLCV';svg.append(info);
  svg.addEventListener('pointermove',event=>{
    const rect=svg.getBoundingClientRect(),px=(event.clientX-rect.left)/rect.width*1200,py=(event.clientY-rect.top)/rect.height*620;
    if(chartGestureActive||px<left||px>left+plotW||py<top||py>top+plotH)return;
    const index=Math.max(0,Math.min(visible.length-1,Math.floor((px-left)/xStep))),c=visible[index],price=ceiling-(py-top)/plotH*span;
    crossV.setAttribute('x1',px);crossV.setAttribute('x2',px);crossV.setAttribute('opacity','1');crossH.setAttribute('y1',py);crossH.setAttribute('y2',py);crossH.setAttribute('opacity','1');
    info.textContent=new Date((Number(c.time)+19800)*1000).toISOString().slice(11,16)+' IST · O '+showNumber(c.open)+' H '+showNumber(c.high)+' L '+showNumber(c.low)+' C '+showNumber(c.close)+' · V '+showNumber(c.volume,0)+' · CURSOR '+showNumber(price);
  });
  svg.addEventListener('pointerleave',()=>{crossV.setAttribute('opacity','0');crossH.setAttribute('opacity','0');info.textContent='Move over chart for candle time and OHLCV';});
  // TradingView-style direct manipulation: wheel zoom, drag pan, pinch zoom,
  // and price-axis drag scaling. The viewport state survives live-candle redraws.
  const clamp=(value,minValue,maxValue)=>Math.max(minValue,Math.min(maxValue,value));
  const zoomAt=(requestedZoom,clientX)=>{
    const rect=svg.getBoundingClientRect();
    const px=(clientX-rect.left)/rect.width*1200;
    const fraction=clamp((px-left)/plotW,0,1);
    const anchorIndex=startIndex+fraction*visible.length;
    const nextZoom=clamp(requestedZoom,1,Math.max(1,candles.length/8));
    const nextCount=Math.max(8,Math.min(candles.length,Math.ceil(candles.length/nextZoom)));
    const nextStart=anchorIndex-fraction*nextCount;
    chartZoom=nextZoom;
    chartPan=clamp(candles.length-(nextStart+nextCount),0,candles.length-nextCount);
    chartGestureActive=false;
    renderChartViewport();
  };
  svg.addEventListener('wheel',event=>{
    event.preventDefault();
    const rect=svg.getBoundingClientRect();
    const px=(event.clientX-rect.left)/rect.width*1200;
    const factor=event.deltaY<0?1.15:1/1.15;
    if(event.shiftKey||px>=left+plotW){
      chartPriceZoom=clamp(chartPriceZoom*factor,.5,20);
      renderChartViewport();
    }else zoomAt(chartZoom*factor,event.clientX);
  },{passive:false});
  const pointers=new Map();
  let dragState=null,pinchState=null;
  const finishGesture=()=>{
    if(!chartGestureActive)return;
    const svgRect=svg.getBoundingClientRect();
    if(pinchState&&pointers.size>=2){
      const points=[...pointers.values()];
      const distance=Math.hypot(points[0].x-points[1].x,points[0].y-points[1].y);
      const factor=distance/Math.max(1,pinchState.distance);
      const centerX=(points[0].x+points[1].x)/2;
      const requested=pinchState.startZoom*factor;
      svg.style.transform='';
      pointers.clear();dragState=null;pinchState=null;
      zoomAt(requested,centerX);
      return;
    }
    if(dragState&&pointers.size===1){
      const point=[...pointers.values()][0];
      const dx=point.x-dragState.startX,dy=point.y-dragState.startY;
      if(dragState.axis){
        chartPriceZoom=clamp(dragState.startPriceZoom*Math.exp(-dy*.008),.5,20);
      }else{
        const candleShift=dx/Math.max(1,dragState.bounds.width)*1200/dragState.xStep;
        chartPan=clamp(dragState.startPan+candleShift,0,candles.length-visible.length);
      }
    }
    svg.style.transform='';
    pointers.clear();dragState=null;pinchState=null;chartGestureActive=false;
    renderChartViewport();
  };
  svg.addEventListener('pointerdown',event=>{
    if(event.pointerType==='mouse'&&event.button!==0)return;
    event.preventDefault();
    if(event.pointerType==='touch'&&pointers.size===0){
      const now=Date.now();
      if(now-chartLastTouchTap<320){
        chartLastTouchTap=0;resetChartViewport();chartGestureActive=false;renderChartViewport();return;
      }
      chartLastTouchTap=now;
    }
    const rect=svg.getBoundingClientRect();
    const px=(event.clientX-rect.left)/rect.width*1200;
    pointers.set(event.pointerId,{x:event.clientX,y:event.clientY});
    try{svg.setPointerCapture(event.pointerId);}catch{}
    chartGestureActive=true;
    if(pointers.size===1){
      dragState={startX:event.clientX,startY:event.clientY,startPan:chartPan,startPriceZoom:chartPriceZoom,
        axis:px>=left+plotW,bounds:rect,xStep};
    }else if(pointers.size===2){
      const points=[...pointers.values()];
      pinchState={distance:Math.hypot(points[0].x-points[1].x,points[0].y-points[1].y),startZoom:chartZoom};
      dragState=null;
    }
  });
  svg.addEventListener('pointermove',event=>{
    if(!pointers.has(event.pointerId))return;
    event.preventDefault();
    pointers.set(event.pointerId,{x:event.clientX,y:event.clientY});
    if(pointers.size>=2&&pinchState){
      const points=[...pointers.values()];
      const distance=Math.hypot(points[0].x-points[1].x,points[0].y-points[1].y);
      const factor=clamp(distance/Math.max(1,pinchState.distance),.65,1.6);
      svg.style.transform='scale('+factor+')';
      svg.style.transformOrigin='center center';
    }else if(dragState){
      const dx=event.clientX-dragState.startX,dy=event.clientY-dragState.startY;
      if(Math.abs(dx)>6 && !dragState.axis) chartFollowLive=false;
      svg.style.transform=dragState.axis?'scaleY('+clamp(Math.exp(-dy*.008),.7,1.4)+')':'translateX('+dx+'px)';
    }
  });
  svg.addEventListener('pointerup',finishGesture);
  svg.addEventListener('pointercancel',finishGesture);
  svg.addEventListener('lostpointercapture',finishGesture);
  svg.addEventListener('dblclick',()=>{resetChartViewport();chartGestureActive=false;renderChartViewport();});
  // Draw the watermark after candles/zones so it remains visible on dark charts.
  // Pointer events stay disabled so chart crosshair and OHLCV inspection keep working.
  const watermark = document.createElementNS(ns, 'text');
  watermark.setAttribute('class', 'chart-symbol-watermark');
  watermark.setAttribute('x', '592');
  watermark.setAttribute('y', '315');
  watermark.setAttribute('text-anchor', 'middle');
  watermark.setAttribute('dominant-baseline', 'middle');
  watermark.setAttribute('fill', '#b8c9df');
  watermark.setAttribute('fill-opacity', '0.22');
  watermark.setAttribute('stroke', '#b8c9df');
  watermark.setAttribute('stroke-opacity', '0.08');
  watermark.setAttribute('stroke-width', '1');
  watermark.setAttribute('font-size', '72');
  watermark.setAttribute('font-weight', '900');
  watermark.setAttribute('letter-spacing', '4');
  watermark.setAttribute('pointer-events', 'none');
  watermark.textContent = chartSymbolLabel;
  svg.append(watermark);
  area.append(svg);
  const livePresent = Boolean(chartLiveCandle && visible.some(c=>c.time===chartLiveCandle.time));
  document.querySelector('#chart-candle-status').textContent=(visible.length-(livePresent?1:0))+' COMPLETED CANDLES · '+(livePresent?'LIVE 5-MIN CANDLE · TICK BUILT':'WAITING FOR LIVE UNDERLYING TICK');
}

async function clearSelectedOption() {
  selectedContractSymbol = null;
  setupOptionTrigger = null; setupRetryAfter = 0;
  document.querySelector('#option-quantity').textContent = '—';
  document.querySelector('#option-ltp').textContent = '—';
  try {
    await fetch('/api/select-option', { method: 'POST', headers: {'content-type':'application/json'}, body: JSON.stringify({symbol:null}) });
  } catch {}
}
async function loadOptionChain(symbol, underlyingPrice, timestamp = '', selectionGeneration = symbolSelectionGeneration) {
  const status = document.querySelector('#option-status');
  optionChainRetryAt=0; optionChainRetrySymbol=null; optionChainRetryTimestamp=''; optionChainRetryGeneration=0;
  status.textContent = 'LOADING FYERS OPTION CHAIN';
  let retryStatus=0;
  try {
    const query = new URLSearchParams({symbol, strikecount:'10'});
    if (timestamp) query.set('timestamp', timestamp);
    const response = await fetch('/api/option-chain?' + query.toString(), {cache:'no-store'});
    retryStatus=response.status;
    const payload = await readJsonResponse(response, 'OPTION CHAIN /api/option-chain');
    if (selectedSymbol !== symbol || selectionGeneration !== symbolSelectionGeneration) return;
    if (!response.ok || payload.s !== 'ok') throw new Error(payload.reason || payload.message || 'FYERS option chain unavailable · HTTP ' + response.status);
    const data = payload.data || payload;
    optionChainRows = Array.isArray(data.optionsChain) ? data.optionsChain : [];
    const expiries = Array.isArray(data.expiryData) ? data.expiryData : [];
    const expirySelect = document.querySelector('#expiry-select');
    if (!timestamp) {
      expirySelect.replaceChildren();
      for (const expiry of expiries) {
        const option = document.createElement('option');
        option.value = String(expiry.expiry);
        option.textContent = expiry.date;
        expirySelect.append(option);
      }
      if (expiries.length) expirySelect.value = String(expiries[0].expiry);
    }
    if (!optionChainRows.length) throw new Error('No active option contracts returned by FYERS');
    renderOptionStrikes(underlyingPrice);
    status.textContent = 'FYERS CHAIN LOADED · CONTRACT MASTER CHECK REQUIRED';
  } catch (error) {
    if (selectedSymbol !== symbol || selectionGeneration !== symbolSelectionGeneration) return;
    optionChainRows = [];
    document.querySelector('#strike-select').replaceChildren(new Option('—',''));
    const retryDelayMs=getOptionRetryDelayMs(retryStatus);
    if(retryDelayMs!==null) {
      optionChainRetryAt=Date.now()+retryDelayMs;
      optionChainRetrySymbol=symbol;
      optionChainRetryTimestamp=timestamp;
      optionChainRetryGeneration=selectionGeneration;
      status.textContent='OPTION CHAIN TEMPORARILY UNAVAILABLE · RETRY IN '+Math.round(retryDelayMs/1000)+'s · '+String(error.message||'FYERS request failed');
    } else {
      status.textContent = 'OPTION CHAIN UNAVAILABLE · ' + String(error.message || 'No verified contracts');
    }
  }
}
function renderOptionStrikes(underlyingPrice) {
  const select = document.querySelector('#strike-select');
  select.replaceChildren();
  const rows = optionChainRows.filter(row => row.option_type === selectedOptionSide && row.symbol && Number(row.strike_price) > 0);
  rows.sort((a,b)=>Number(a.strike_price)-Number(b.strike_price));
  for (const row of rows) {
    const option = document.createElement('option');
    option.value = row.symbol;
    option.textContent = showNumber(Number(row.strike_price),2);
    select.append(option);
  }
  if (!rows.length) {
    const empty = document.createElement('option'); empty.value = ''; empty.textContent = 'No contracts'; select.append(empty);
    return;
  }
  if (Number.isFinite(Number(underlyingPrice))) {
    const nearest = rows.reduce((best,row)=>Math.abs(Number(row.strike_price)-underlyingPrice)<Math.abs(Number(best.strike_price)-underlyingPrice)?row:best,rows[0]);
    select.value = nearest.symbol;
  }
  selectOptionContract(select.value);
}
function renderResearchResults(setup) {
  const status=document.querySelector('#research-status'),container=document.querySelector('#research-results');
  container.replaceChildren();
  const ranking=Array.isArray(setup?.researchRanking)?setup.researchRanking:[];
  if(ranking.length && ['LONG','SHORT'].includes(ranking[0]?.side)) {
    const desiredSide=ranking[0].side==='LONG'?'CE':'PE';
    const sideChanged=selectedOptionSide!==desiredSide;
    if(sideChanged) {
      selectedOptionSide=desiredSide;
      document.querySelector('#ce-select').classList.toggle('active',desiredSide==='CE');
      document.querySelector('#pe-select').classList.toggle('active',desiredSide==='PE');
    }
    if((sideChanged || !selectedContractSymbol) && selectedSymbol && selectedUnderlyingPrice>0) {
      autoSelectDirectionalOption(desiredSide);
    }
  }
  if(!ranking.length) {
    status.textContent=setup?.research?.status==='UNAVAILABLE'?'RESEARCH DATA INCOMPLETE':'NO VERIFIED RESEARCH RANKING';
    const note=document.createElement('div');note.className='empty-inline';
    note.textContent=setup?.reason||setup?.research?.reason||'No setup passed all nine-strategy and verified-data gates; no score is fabricated.';
    container.append(note);
  }
  if(ranking.length) status.textContent='VERIFIED MULTI-TIMEFRAME · TOP '+ranking.length+' · DIRECTION-AWARE CE/PE';
  for(const item of ranking) {
    const card=document.createElement('article');card.className='research-card';
    const head=document.createElement('div');head.className='research-card-head';
    const name=document.createElement('strong');name.textContent='#'+item.rank+' '+item.strategy;
    const score=document.createElement('b');score.textContent=item.qualityScore+'/100 · '+item.grade;
    head.append(name,score);
    const tf=document.createElement('p');tf.textContent='15m '+item.timeframes.fifteenMinute+' · 5m '+item.timeframes.fiveMinute;
    const evidence=document.createElement('small');evidence.textContent=(item.evidence||[]).join(' · ');
    const target=document.createElement('small');target.textContent='AI target: '+(item.targetR||2)+'R · '+(item.targetRationale||'Minimum 2R');
    const invalid=document.createElement('small');invalid.textContent='Invalidation: '+item.invalidation;
    card.append(head,tf,evidence,target,invalid);container.append(card);
  }
  const ledger=Array.isArray(setup?.strategyLedger)?setup.strategyLedger:[];
  if(ledger.length) {
    const heading=document.createElement('strong');heading.textContent='NINE-STRATEGY DIAGNOSTIC LEDGER';container.append(heading);
    for(const item of ledger) {
      const row=document.createElement('div');row.className='strategy-ledger-row';
      const label=document.createElement('b');label.textContent=item.strategy+' · '+item.status;
      const reason=document.createElement('small');reason.textContent=item.reason||'No diagnostic reason returned';
      row.append(label,reason);container.append(row);
    }
  }
}
function renderEntryEvaluationGate(md) {
  let panel=document.getElementById('entry-eval-gate');
  if(!panel) {
    panel=document.createElement('div');
    panel.id='entry-eval-gate';
    panel.className='empty-inline';
    panel.setAttribute('aria-live','polite');
    const ledger=document.getElementById('setup-ledger');
    if(ledger?.parentNode) ledger.parentNode.insertBefore(panel,ledger.nextSibling);
  }
  const underlying=md?.selectedUnderlying;
  const option=md?.selectedOption;
  const checks=[
    ['UNDERLYING',Boolean(selectedSymbol && underlying?.symbol===selectedSymbol && underlying?.fresh)],
    ['OFFICIAL CONTRACT',Boolean(selectedContractSymbol)],
    ['OPTION TICK',Boolean(selectedContractSymbol && option?.symbol===selectedContractSymbol && option?.fresh)],
  ];
  const fifteenMinuteContextReady=researchContextReadySymbol===selectedSymbol;
  const blockers=checks.filter(([,ok])=>!ok).map(([name])=>name);
  let state='READY · WAITING FOR EVALUATION';
  if(setupEvaluationRunning) state='ENTRY EVALUATION RUNNING';
  else if(setupEvaluationDone) state='EVALUATION COMPLETE · WAIT NEXT VALID TRIGGER';
  else if(setupRetryAfter>Date.now()) state='RETRY COOLDOWN · '+Math.ceil((setupRetryAfter-Date.now())/1000)+'s';
  else if(blockers.length) state='BLOCKED · '+blockers.join(' + ');
  panel.textContent='ENTRY EVAL GATE · '+state+' · '+checks.map(([name,ok])=>name+': '+(ok?'PASS':'WAIT')).join(' · ')+' · 15M HISTORY: '+(fifteenMinuteContextReady?'READY':'WARMING · ENTRY EVALUATION USES FRESH 15M/5M');
}
async function evaluateSelectedSetup() {
  // Live entry is driven by the selected underlying/option freshness and each
  // strategy's own price rules. Research warmup is a separate ranking panel.
  if (setupEvaluationRunning || setupEvaluationDone || !selectedSymbol || !selectedContractSymbol) return;
  setupEvaluationRunning = true;
  const evaluatedSymbol=selectedSymbol,evaluatedContract=selectedContractSymbol;
  const state=document.querySelector('#setup-state');
  state.textContent='VERIFYING 9 STRATEGIES · FYERS DATA';
  const researchStatus=document.querySelector('#research-status');
  researchStatus.textContent=(evaluatedSymbol.replace(/^(NSE|BSE):/,'').replace(/-EQ$/,'')+' · NINE-STRATEGY RESEARCH RUNNING');
  const researchResults=document.querySelector('#research-results');
  researchResults.replaceChildren();
  const researchNote=document.createElement('div');
  researchNote.className='empty-inline';
  researchNote.textContent='Checking fresh FYERS 15-minute trend and completed 5-minute price candles for the selected stock.';
  researchResults.append(researchNote);
  for(const id of ['setup-entry','setup-sl','setup-target','setup-rr']) document.getElementById(id).textContent='—';
  chartSetupLevels = null;
  renderChartViewport();
  try {
    const response=await fetch('/api/evaluate-setup',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({underlying:selectedSymbol,contract:selectedContractSymbol})});
    const setup=await response.json();
    if(selectedSymbol!==evaluatedSymbol||selectedContractSymbol!==evaluatedContract)return;
    setupEvaluationDone = true;
    if(response.status===429) {
      setupOptionTrigger=null;
      setupRetryAfter=Number.isFinite(Number(setup.retryAt))&&Number(setup.retryAt)>Date.now()
        ?Number(setup.retryAt):Date.now()+60_000;
      state.textContent='FYERS REST COOLDOWN · ENTRY CHECK PAUSED UNTIL SAFE RETRY';
      state.dataset.state='blocked';
      return;
    }
    if(response.status>=500) {
      setupRetryAfter=Date.now()+15000;
      state.textContent='SERVER TEMPORARILY UNAVAILABLE · ENTRY CHECK WILL RETRY';
      state.dataset.state='blocked';
      return;
    }
    setupOptionTrigger = null; setupRetryAfter = 0;
    if (Array.isArray(setup.researchRanking) || Array.isArray(setup.strategyLedger)) renderResearchResults(setup);
    const marketStatus = await fetch('/api/market-data',{cache:'no-store'}).then(r=>r.json()).catch(()=>null);
    setupLastBucket = marketStatus?.selectedUnderlying?.exchangeTime ? Math.floor(Number(marketStatus.selectedUnderlying.exchangeTime)/300)*300 : setupLastBucket;
    if (setup.status === 'WAITING_FOR_OPTION_BREAKOUT' && Number.isFinite(Number(setup.entryTriggerPrice)) && Number.isFinite(Number(setup.optionTickSize)) && Number(setup.optionTickSize) > 0) {
      setupOptionTrigger = { entryTriggerPrice:Number(setup.entryTriggerPrice), tickSize:Number(setup.optionTickSize), bucket:setupLastBucket };
    } else if (setup.status === 'DATA_UNAVAILABLE_NO_TRADE' && /(?:underlying|option) tick (?:became stale|is not fresh)|Fresh FYERS .* tick is required/i.test(String(setup.reason||''))) {
      setupRetryAfter = Date.now() + 5000;
    }
    if(setup.status==='SETUP_CONFIRMED') {
      const retained=registerTriggeredSetup(setup,evaluatedSymbol,evaluatedContract);
      if(!retained.ok) { state.textContent='ENTRY NOT ADDED · '+retained.reason; state.dataset.state='blocked'; chartSetupLevels=null; renderChartViewport(); return; }
      const fixed=retained.row;
      document.querySelector('#setup-entry').textContent='₹'+showNumber(fixed.entry);
      document.querySelector('#setup-sl').textContent='₹'+showNumber(fixed.stopLoss);
      document.querySelector('#setup-target').textContent='₹'+showNumber(fixed.target);
      document.querySelector('#setup-rr').textContent='1:'+showNumber(fixed.rr);
      state.textContent=(fixed.status==='ACTIVE'?'ACTIVE ENTRY RETAINED · ':'PREVIOUS TRIGGER · ')+fixed.strategy+' · '+fixed.contract+' · '+(fixed.status==='ACTIVE'?'MONITORING FIXED SL / TARGET':fixed.status.replaceAll('_',' ')); state.dataset.state=fixed.status==='ACTIVE'?'confirmed':'blocked';
      if(!retained.existing) chartSetupLevels = { entry: Number(setup.entry), stopLoss: Number(setup.stopLoss), target: Number(setup.target) };
      else chartSetupLevels = { entry: Number(fixed.entry), stopLoss: Number(fixed.stopLoss), target: Number(fixed.target) };
      renderChartViewport();
    } else {
      chartSetupLevels = null; renderChartViewport();
      state.textContent=setup.status==='WAITING_FOR_OPTION_BREAKOUT'&&Number.isFinite(Number(setup.entryTriggerPrice))?'WAITING FOR OPTION BREAKOUT · TRIGGER ₹'+showNumber(setup.entryTriggerPrice)+' · LIVE TICK WATCH':(setup.status||'NO TRADE')+' · '+(setup.reason||'No confirmed setup'); state.dataset.state='blocked';
    }
  } catch(error) { setupEvaluationDone=true; setupRetryAfter=Date.now()+15000; chartSetupLevels=null; renderChartViewport(); state.textContent='NO TRADE · TEMPORARY REQUEST FAILURE · RETRY SCHEDULED'; state.dataset.state='blocked'; }
  finally { setupEvaluationRunning=false; }
}
function selectCandidateForEntry(candidate, options={}) {
  const automatic=Boolean(options.automatic);
  const symbol=String(candidate?.symbol||'').trim();
  const side=candidate?.side==='LONG'?'CE':candidate?.side==='SHORT'?'PE':null;
  if(!symbol||!side)return;
  if(!automatic) userSelectedSymbol=true;
  // Carry the verified setup direction before the option chain renders, so
  // nearest-strike selection cannot inherit a stale CE/PE side.
  selectedOptionSide=side;
  document.querySelector('#ce-select').classList.toggle('active',side==='CE');
  document.querySelector('#pe-select').classList.toggle('active',side==='PE');
  if(selectedSymbol===symbol&&!chartRestoredFromCache) {
    if(selectedUnderlyingPrice>0&&optionChainRows.length) {
      if(!selectedContractSymbol||!selectedContractSymbol.endsWith(side)) renderOptionStrikes(selectedUnderlyingPrice);
    } else if(selectedUnderlyingPrice>0) {
      void loadOptionChain(symbol,selectedUnderlyingPrice,'',symbolSelectionGeneration);
    } else if(automatic) {
      // The chart's first history request may still be in flight. Permit the
      // next 30-second universe refresh to retry this same Top-1 handoff.
      lastAutoTop3CandidateKey=null;
    }
    return;
  }
  void selectSymbol(symbol);
}

async function autoSelectDirectionalOption(optionSide) {
  const requestGeneration=++optionSelectionGeneration;
  const requestedUnderlying=selectedSymbol,requestedSide=optionSide;
  const status=document.querySelector('#option-status');
  const expiry=document.querySelector('#expiry-select').value;
  selectedContractSymbol=null; setupOptionTrigger=null; setupRetryAfter=0; setupEvaluationDone=true;
  optionSelectionRetryAt=0; optionSelectionRetrySymbol=null; optionSelectionRetryMode='AUTO'; optionSelectionRetrySide=null; optionSelectionRetryExpiry=null;
  status.textContent='AUTO-SELECTING '+optionSide+' · VERIFYING FYERS MASTER';
  let retryStatus=0;
  let retryReason='';
  try {
    const response=await fetch('/api/auto-select-option',{method:'POST',headers:{'content-type':'application/json'},
      body:JSON.stringify({underlying:requestedUnderlying,side:requestedSide==='CE'?'LONG':'SHORT',timestamp:expiry})});
    retryStatus=response.status;
    const result=await response.json();
    retryReason=String(result.reason||'');
    if(requestGeneration!==optionSelectionGeneration||selectedSymbol!==requestedUnderlying||selectedOptionSide!==requestedSide||document.querySelector('#expiry-select').value!==expiry)return;
    if(!response.ok||result.status!=='AUTO_CONTRACT_VERIFIED_SUBSCRIPTION_REQUESTED') throw new Error(result.reason||'Automatic option selection failed');
    selectedContractSymbol=result.contract.symbol;
    optionSelectionRetryAt=0; optionSelectionRetrySymbol=null; optionSelectionRetryMode='MANUAL'; optionSelectionRetrySide=null; optionSelectionRetryExpiry=null;
    setupOptionTrigger=null; setupRetryAfter=0; chartSetupLevels=null; renderChartViewport();
    const strikeSelect=document.querySelector('#strike-select');
    if(optionChainRows.some(row=>row.symbol===selectedContractSymbol)) strikeSelect.value=selectedContractSymbol;
    document.querySelector('#option-quantity').textContent=showNumber(result.contract.lotSize,0);
    document.querySelector('#option-ltp').textContent='WAITING FOR LIVE OPTION TICK';
    status.textContent='AUTO '+result.contract.side+' · STRIKE '+showNumber(result.contract.strike)+' · EXP '+showExpiry(result.contract.expiry)+' · LOT '+showNumber(result.contract.lotSize,0)+' · TICK '+showNumber(result.contract.tickSize,4)+' · MASTER VERIFIED · '+(result.subscription?.status||'SUBSCRIPTION PENDING');
    setupEvaluationDone=false;
    document.querySelector('#setup-state').textContent='WAITING FOR FRESH UNDERLYING + OPTION TICKS';
  } catch(error) {
    if(requestGeneration!==optionSelectionGeneration||selectedSymbol!==requestedUnderlying||selectedOptionSide!==requestedSide||document.querySelector('#expiry-select').value!==expiry)return;
    selectedContractSymbol=null; setupOptionTrigger=null; setupRetryAfter=0; setupEvaluationDone=true;
    const retryDelayMs=getOptionRetryDelayMs(retryStatus,retryReason);
    if(retryDelayMs!==null) {
      optionSelectionRetryAt=Date.now()+retryDelayMs;
      optionSelectionRetrySymbol=requestedUnderlying;
      optionSelectionRetryMode='AUTO';
      optionSelectionRetrySide=requestedSide;
      optionSelectionRetryExpiry=expiry;
    }
    document.querySelector('#option-quantity').textContent='—';
    status.textContent='AUTO OPTION NOT VERIFIED · '+String(error.message||'No action')+(retryDelayMs!==null?' · RETRY IN '+Math.round(retryDelayMs/1000)+'s':'');
  }
}
async function selectOptionContract(symbol) {
  if (!symbol) return;
  const requestGeneration=++optionSelectionGeneration;
  const requestedUnderlying=selectedSymbol,requestedSymbol=symbol;
  const status = document.querySelector('#option-status');
  selectedContractSymbol=null; setupOptionTrigger=null; setupRetryAfter=0; setupEvaluationDone=true;
  optionSelectionRetryAt=0; optionSelectionRetrySymbol=null; optionSelectionRetryMode='MANUAL'; optionSelectionRetrySide=null; optionSelectionRetryExpiry=null;
  status.textContent = 'VERIFYING EXACT CONTRACT IN FYERS MASTER';
  let retryStatus=0;
  try {
    const response = await fetch('/api/select-option', {
      method:'POST', headers:{'content-type':'application/json'}, body:JSON.stringify({symbol:requestedSymbol})
    });
    retryStatus=response.status;
    const result = await response.json();
    if(requestGeneration!==optionSelectionGeneration||selectedSymbol!==requestedUnderlying||document.querySelector('#strike-select').value!==requestedSymbol)return;
    if (!response.ok || result.status !== 'CONTRACT_VERIFIED_SUBSCRIPTION_REQUESTED') throw new Error(result.reason || 'Contract master verification failed');
    selectedContractSymbol = result.contract.symbol;
    optionSelectionRetryAt=0; optionSelectionRetrySymbol=null; optionSelectionRetryMode='MANUAL'; optionSelectionRetrySide=null; optionSelectionRetryExpiry=null;
    setupOptionTrigger = null; setupRetryAfter = 0;
    chartSetupLevels = null; renderChartViewport();
    setupEvaluationDone = false;
    document.querySelector('#option-quantity').textContent = showNumber(result.contract.lotSize,0);
    document.querySelector('#option-ltp').textContent = 'WAITING FOR LIVE OPTION TICK';
    const subscriptionState = result.subscription?.status || 'SUBSCRIPTION_STATE_UNAVAILABLE';
    status.textContent = result.contract.side + ' · STRIKE ' + showNumber(result.contract.strike) + ' · EXP ' + showExpiry(result.contract.expiry) + ' · LOT ' + showNumber(result.contract.lotSize,0) + ' · TICK ' + showNumber(result.contract.tickSize,4) + ' · MASTER VERIFIED · ' + subscriptionState + ' · LIVE TICK PENDING';
    document.querySelector('#setup-state').textContent='WAITING FOR FRESH UNDERLYING + OPTION TICKS';
  } catch (error) {
    if(requestGeneration!==optionSelectionGeneration||selectedSymbol!==requestedUnderlying||document.querySelector('#strike-select').value!==requestedSymbol)return;
    selectedContractSymbol = null; setupOptionTrigger=null; setupRetryAfter=0; setupEvaluationDone=true;
    const retryDelayMs=getOptionRetryDelayMs(retryStatus);
    if(retryDelayMs!==null) { optionSelectionRetryAt=Date.now()+retryDelayMs; optionSelectionRetrySymbol=requestedSymbol; optionSelectionRetryMode='MANUAL'; }
    document.querySelector('#option-quantity').textContent = '—';
    status.textContent = 'CONTRACT NOT VERIFIED · ' + String(error.message || 'No action') + (retryDelayMs!==null?' · RETRY IN '+Math.round(retryDelayMs/1000)+'s':'');
  }
}
document.querySelector('#ce-select').addEventListener('click',()=>{
  selectedOptionSide='CE';
  document.querySelector('#ce-select').classList.add('active');
  document.querySelector('#pe-select').classList.remove('active');
  renderOptionStrikes(selectedUnderlyingPrice);
});
document.querySelector('#pe-select').addEventListener('click',()=>{
  selectedOptionSide='PE';
  document.querySelector('#pe-select').classList.add('active');
  document.querySelector('#ce-select').classList.remove('active');
  renderOptionStrikes(selectedUnderlyingPrice);
});
document.querySelector('#strike-select').addEventListener('change',event=>selectOptionContract(event.target.value));
document.querySelector('#expiry-select').addEventListener('change',()=>{
  if (selectedSymbol && document.querySelector('#expiry-select').value) loadOptionChain(selectedSymbol,selectedUnderlyingPrice,document.querySelector('#expiry-select').value);
});


// Search the complete official F&O master, not only the currently rotating socket slice.
const fnoSearchInput=document.querySelector('#fno-search-input');
const fnoSearchResults=document.querySelector('#fno-search-results');
const fnoSearchStatus=document.querySelector('#fno-search-status');
let fnoSearchSequence=0;
let fnoSearchDebounce=null;
function renderFnoSearchResults(payload, sequence) {
  if(sequence!==fnoSearchSequence)return;
  fnoSearchResults.replaceChildren();
  if(!payload.results?.length) {
    const empty=document.createElement('div');empty.className='empty-inline';
    empty.textContent=payload.status==='SYMBOL_MASTER_NOT_LOADED'
      ? 'Official FYERS F&O master is not ready. Search is temporarily unavailable.'
      : 'No matching active NSE F&O underlying found in the official FYERS master.';
    fnoSearchResults.append(empty);return;
  }
  for(const item of payload.results) {
    const button=document.createElement('button');button.type='button';button.className='fno-search-result';
    const name=document.createElement('strong');name.textContent=String(item.name||item.underlying||item.symbol);
    const symbol=document.createElement('small');symbol.textContent=item.symbol+' · OFFICIAL F&O MASTER';
    button.append(name,symbol);
    button.addEventListener('click',()=>{
      fnoSearchInput.value=String(item.underlying||item.symbol).replace(/^NSE:/,'').replace(/-EQ$/,'');
      fnoSearchResults.replaceChildren();
      const note=document.createElement('div');note.className='empty-inline';note.textContent='Selected '+item.symbol+' · loading verified chart and option chain…';
      fnoSearchResults.append(note);
      selectUserSymbol(item.symbol);
    });
    fnoSearchResults.append(button);
  }
}
async function runFnoSymbolSearch() {
  const query=fnoSearchInput.value.trim();
  const sequence=++fnoSearchSequence;
  if(query.length<2) {
    fnoSearchStatus.textContent='TYPE AT LEAST 2 CHARACTERS';
    fnoSearchResults.replaceChildren();
    const note=document.createElement('div');note.className='empty-inline';note.textContent='Enter a symbol or company name to search the complete official F&O universe.';
    fnoSearchResults.append(note);return;
  }
  fnoSearchStatus.textContent='SEARCHING OFFICIAL FYERS F&O MASTER…';
  try {
    const response=await fetch('/api/fno/search?q='+encodeURIComponent(query),{cache:'no-store'});
    const payload=await readJsonResponse(response,'OFFICIAL F&O SYMBOL SEARCH');
    if(!response.ok)throw new Error(payload.reason||'Official F&O search unavailable');
    if(sequence!==fnoSearchSequence)return;
    fnoSearchStatus.textContent=(payload.resultCount||0)+' MATCHES · '+(payload.universeCount||0)+' OFFICIAL UNDERLYINGS';
    renderFnoSearchResults(payload,sequence);
  } catch(error) {
    if(sequence!==fnoSearchSequence)return;
    fnoSearchStatus.textContent='SEARCH UNAVAILABLE';
    fnoSearchResults.replaceChildren();
    const note=document.createElement('div');note.className='empty-inline';note.textContent=String(error.message||'F&O search unavailable')+' · NO SYMBOL ASSUMED';
    fnoSearchResults.append(note);
  }
}
fnoSearchInput.addEventListener('input',()=>{
  clearTimeout(fnoSearchDebounce);
  fnoSearchDebounce=setTimeout(runFnoSymbolSearch,250);
});
fnoSearchInput.addEventListener('keydown',event=>{
  if(event.key==='Enter'){clearTimeout(fnoSearchDebounce);runFnoSymbolSearch();}
});

renderActiveSetups();
