const DATA_BASE = 'https://api-t1.fyers.in/data';
const PATHS = Object.freeze({
  expiryDates:'/history/fno/expired/expiry-dates',
  expiredContracts:'/history/fno/expired/underlying-symbols',
  expiredHistory:'/history/fno/expired/historical-data'
});

/**
 * Minimal read-only FYERS expired-F&O REST adapter for the isolated research
 * worker. It intentionally exposes no order, account, quote or live socket API.
 */
export function createFyersExpiredOptionClient({appId,accessToken,fetchImpl=globalThis.fetch}={}) {
  if (typeof appId!=='string' || !appId.trim() ||
      typeof accessToken!=='string' || !accessToken.trim() ||
      typeof fetchImpl!=='function') {
    throw new Error('FYERS app ID, access token and fetch implementation are required');
  }
  const get=async(path,params)=>{
    const url=new URL(DATA_BASE+path);
    for(const [key,value] of Object.entries(params||{})) {
      if(value===undefined||value===null||String(value)==='') continue;
      url.searchParams.set(key,String(value));
    }
    const response=await fetchImpl(url.toString(),{
      method:'GET',
      headers:{Authorization:appId.trim()+':'+accessToken.trim(),Accept:'application/json'},
      signal:AbortSignal.timeout(20000)
    });
    const raw=await response.text();
    let body;
    try { body=JSON.parse(raw); }
    catch { throw new Error('FYERS expired-F&O endpoint returned non-JSON (HTTP '+response.status+')'); }
    if(!response.ok) throw new Error('FYERS expired-F&O HTTP '+response.status+': '+String(body.message||body.s||'request failed').slice(0,160));
    return body;
  };
  return Object.freeze({
    expiry_dates:args=>get(PATHS.expiryDates,args),
    history_underlying_symbols:args=>get(PATHS.expiredContracts,args),
    fno_historical_data:args=>get(PATHS.expiredHistory,args)
  });
}

export const FYERS_EXPIRED_OPTION_ENDPOINTS=PATHS;
