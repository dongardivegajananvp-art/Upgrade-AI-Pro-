async function refresh(){try{const r=await fetch('/api/status',{cache:'no-store'});const s=await r.json();const auth=s.auth?.status||'UNKNOWN';document.querySelector('#feed').textContent='FYERS · '+(s.feed.status==='FRESH'?'LIVE TICK VERIFIED':auth.replaceAll('_',' '))+' · NSE ONLY';}catch{document.querySelector('#feed').textContent='BACKEND DISCONNECTED';}}
refresh();setInterval(refresh,5000);
if('serviceWorker' in navigator) window.addEventListener('load',()=>navigator.serviceWorker.register('/sw.js').catch(()=>{}));
