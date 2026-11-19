const labels = [
  ['NSE:NIFTY50-INDEX','nifty','nifty-change'],
  ['NSE:NIFTYBANK-INDEX','bank','bank-change'],
  ['BSE:SENSEX-INDEX','sensex','sensex-change']
];
function showNumber(value, digits=2) {
  return Number.isFinite(Number(value)) ? Number(value).toLocaleString('en-IN',{maximumFractionDigits:digits}) : '—';
}
async function refresh() {
  try {
    const r = await fetch('/api/status',{cache:'no-store'});
    if (!r.ok) throw new Error('status unavailable');
    const s = await r.json();
    const md = s.marketData || {};
    const indices = md.indices || {};
    let freshCount = 0;
    for (const [symbol, priceId, changeId] of labels) {
      const tick = indices[symbol];
      const price = document.getElementById(priceId);
      const change = document.getElementById(changeId);
      if (tick?.fresh) {
        freshCount++;
        price.textContent = showNumber(tick.price);
        const pct = Number.isFinite(Number(tick.changePercent)) ? Number(tick.changePercent) : null;
        change.textContent = pct === null ? 'CHANGE UNAVAILABLE' : `${pct >= 0 ? '+' : ''}${pct.toFixed(2)}%`;
        change.dataset.state = pct === null ? 'unknown' : pct >= 0 ? 'up' : 'down';
      } else {
        price.textContent = '—';
        change.textContent = tick ? 'STALE · NOT ACTIONABLE' : 'WAITING FOR FYERS TICK';
        change.dataset.state = 'unknown';
      }
    }
    const feed = document.querySelector('#feed');
    if (freshCount === 3) feed.textContent = 'FYERS · 3/3 INDEX TICKS FRESH · NSE ONLY';
    else if (freshCount > 0) feed.textContent = `FYERS · ${freshCount}/3 INDEX TICKS FRESH · PARTIAL FEED`;
    else feed.textContent = 'FYERS · ' + (md.socketStatus || s.auth?.status || 'NOT CONNECTED').replaceAll('_',' ') + ' · NO VERIFIED LIVE TICK';
  } catch {
    document.querySelector('#feed').textContent = 'BACKEND DISCONNECTED';
  }
}
refresh();
setInterval(refresh,2000);
if('serviceWorker' in navigator) window.addEventListener('load',()=>navigator.serviceWorker.register('/sw.js').catch(()=>{}));
