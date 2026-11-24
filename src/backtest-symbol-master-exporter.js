import { createHash } from 'node:crypto';
import { mkdir, writeFile, rename } from 'node:fs/promises';
import path from 'node:path';

export const FYERS_MASTER_SOURCE = 'FYERS_OFFICIAL_SYMBOL_MASTER';
export const FYERS_MASTER_URLS = Object.freeze({
  NSE_FO: 'https://public.fyers.in/sym_details/NSE_FO_sym_master.json',
  NSE_CM: 'https://public.fyers.in/sym_details/NSE_CM_sym_master.json'
});
const sha256 = value => createHash('sha256').update(value).digest('hex');
async function atomicWrite(file,bytes){const temp=file+'.tmp';await writeFile(temp,bytes,{flag:'wx'});await rename(temp,file);}
function parseMaster(raw,label){let value;try{value=JSON.parse(raw.toString('utf8'));}catch{throw new Error('FYERS '+label+' symbol master is not valid JSON');}if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).length<10)throw new Error('FYERS '+label+' symbol master is empty or malformed');return value;}
export function buildNseFnoEquityUniverse(foMaster,cmMaster){\n if(!foMaster||typeof foMaster!=='object'||Array.isArray(foMaster)||Object.keys(foMaster).length<10||!cmMaster||typeof cmMaster!=='object'||Array.isArray(cmMaster)||Object.keys(cmMaster).length<10)throw new Error('Official FYERS NSE symbol masters are empty or malformed');
 const fnoTokens=new Map();
 for(const [key,row] of Object.entries(foMaster)){if(!row||typeof row!=='object')continue;const token=String(row.underFyTok||'').trim();const ticker=String(row.symTicker||key).trim().toUpperCase();if(token&&ticker.startsWith('NSE:')&&(row.tradeStatus===undefined||Number(row.tradeStatus)===1))fnoTokens.set(token,(fnoTokens.get(token)||0)+1);}
 const symbols=[],seen=new Set();
 for(const [key,row] of Object.entries(cmMaster)){if(!row||typeof row!=='object')continue;const symbol=String(row.symTicker||key).trim().toUpperCase();const token=String(row.fyToken||'').trim();const series=String(row.exSeries||'').trim().toUpperCase();if(!/^NSE:[A-Z0-9&._-]{1,48}-EQ$/.test(symbol)||series!=='EQ'||!token||(row.tradeStatus!==undefined&&Number(row.tradeStatus)!==1))continue;const foInstrumentCount=fnoTokens.get(token)||0;if(!foInstrumentCount||seen.has(symbol))continue;seen.add(symbol);symbols.push({symbol,underlying:String(row.exSymbol||symbol.slice(4,-3)),fyToken:token,foInstrumentCount,lastUpdate:row.lastUpdate||null});}
 symbols.sort((a,b)=>a.symbol.localeCompare(b.symbol));
 if(symbols.length<50)throw new Error('Official NSE F&O to NSE EQ FY token mapping yielded fewer than 50 equities; refusing to label this a complete universe');
 return symbols;
}
/** Fetches only FYERS public symbol-master files; no auth and no live app imports. */
export async function downloadOfficialNseFnoEquityMaster({outputDir,fetchImpl=globalThis.fetch,now=Date.now()}={}){
 if(!outputDir||typeof fetchImpl!=='function')throw new Error('Output directory and fetch implementation are required');
 const dir=path.resolve(outputDir);await mkdir(dir,{recursive:true});const downloads={};
 for(const [name,url] of Object.entries(FYERS_MASTER_URLS)){
  const response=await fetchImpl(url,{method:'GET',headers:{Accept:'application/json'},signal:AbortSignal.timeout(20000)});
  const raw=Buffer.from(await response.arrayBuffer());
  if(!response.ok||raw.length<1000)throw new Error('FYERS official '+name+' symbol master download failed (HTTP '+response.status+')');
  const parsed=parseMaster(raw,name);downloads[name]={url,raw,parsed,sha256:sha256(raw),recordCount:Object.keys(parsed).length};
  await atomicWrite(path.join(dir,name+'_sym_master.json'),raw);
 }
 const symbols=buildNseFnoEquityUniverse(downloads.NSE_FO.parsed,downloads.NSE_CM.parsed);
 const latestUpdate=symbols.map(x=>x.lastUpdate).filter(Boolean).sort().at(-1)||null;
 const master={format:'UPGRADE_AI_PRO_FYERS_NSE_FNO_MASTER_V1',source:FYERS_MASTER_SOURCE,verifiedOfficialMaster:true,retrievedAt:new Date(now).toISOString(),symbols,sourceFiles:Object.fromEntries(Object.entries(downloads).map(([name,v])=>[name,{url:v.url,file:name+'_sym_master.json',sha256:v.sha256,recordCount:v.recordCount}])),mapping:{from:'NSE_FO.underFyTok',to:'NSE_CM.fyToken',equitySeries:'EQ',activeOnly:true},newestEquityLastUpdate:latestUpdate,operatorNote:'Downloaded directly from FYERS public symbol-master URLs. Hashes attest to downloaded bytes; they are not a broker digital signature.'};
 const masterFile=path.join(dir,'official-master.json');await atomicWrite(masterFile,Buffer.from(JSON.stringify(master,null,2)+'\n'));return{masterFile,master};
}
if(process.argv[1]&&path.resolve(process.argv[1])===path.resolve(new URL(import.meta.url).pathname)){try{const [outputDir]=process.argv.slice(2);const result=await downloadOfficialNseFnoEquityMaster({outputDir});process.stdout.write(JSON.stringify({status:'MASTER_READY',masterFile:result.masterFile,equityCount:result.master.symbols.length,source:result.master.source,actionable:false})+'\n');}catch(error){process.stderr.write(JSON.stringify({status:'MASTER_UNAVAILABLE',reason:String(error?.message||error).slice(0,240),actionable:false})+'\n');process.exitCode=1;}}
