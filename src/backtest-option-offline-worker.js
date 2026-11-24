import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import path from 'node:path';
import { gunzipSync } from 'node:zlib';
import { simulateExpiredOptionSignal, summarizeExpiredOptionReplay } from './backtest-option-execution.js';

const FORMAT='UPGRADE_AI_PRO_OPTION_EXECUTION_DATASET_V1';
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
function filename(value){
 if(typeof value!=='string'||!/^[A-Za-z0-9._-]{1,120}\.json$/.test(value)||value.includes('..'))throw new Error('Offline option dataset filename is invalid');
 return value;
}
function masterFilename(value){
 if(typeof value!=='string'||!/^NSE_FO_contract_\d{8}\.csv\.gz$/.test(value))throw new Error('Official NSE daily F&O master filename is invalid');
 return value;
}

function csvRecords(text){
 const rows=[];let row=[],field='',quoted=false;
 for(let i=0;i<text.length;i++){
  const ch=text[i];
  if(quoted){if(ch==='"'&&text[i+1]==='"'){field+='"';i++;}else if(ch==='"')quoted=false;else field+=ch;continue;}
  if(ch==='"'){quoted=true;continue;}
  if(ch===','){row.push(field);field='';continue;}
  if(ch==='\\n'){row.push(field.replace(/\\r$/,''));if(row.some(v=>v!==''))rows.push(row);row=[];field='';continue;}
  field+=ch;
 }
 if(field!==''||row.length){row.push(field.replace(/\\r$/,''));rows.push(row);}
 return rows;
}
function normHeader(value){return String(value||'').toLowerCase().replace(/[^a-z0-9]/g,'');}
function nseDate(value){
 const raw=String(value||'').trim();
 if(/^\\d{4}-\\d{2}-\\d{2}$/.test(raw))return raw;
 if(/^\\d{8}$/.test(raw))return raw.slice(4,8)+'-'+raw.slice(2,4)+'-'+raw.slice(0,2);
 const m=raw.match(/^(\\d{1,2})[- ]([A-Za-z]{3})[- ](\\d{2,4})$/);
 if(!m)return null;
 const months={jan:'01',feb:'02',mar:'03',apr:'04',may:'05',jun:'06',jul:'07',aug:'08',sep:'09',oct:'10',nov:'11',dec:'12'};
 const year=m[3].length===2?'20'+m[3]:m[3];
 return year+'-'+(months[m[2].toLowerCase()]||'00')+'-'+m[1].padStart(2,'0');
}
function verifyContractMaster(bytes,spec,optionDataset){
 let text;
 try{text=gunzipSync(bytes).toString('utf8').replace(/^\\uFEFF/,'');}catch{throw new Error('Official NSE daily F&O contract master is not a valid gzip CSV');}
 const rows=csvRecords(text);
 if(rows.length<2)throw new Error('Official NSE daily F&O contract master has no contract rows');
 const headers=rows[0].map(normHeader);
 const index=(...names)=>headers.findIndex(h=>names.includes(h));
 const columns={
  symbol:index('symbol','underlyingsymbol'),
  expiry:index('expiry','expirydate'),
  strike:index('strike','strikeprice'),
  side:index('optiontype','optiontypecode','opttype'),
  tick:index('ticksize','pricetick','tick')
 };
 if(Object.values(columns).some(v=>v<0))throw new Error('NSE contract master CSV is missing required Symbol, Expiry, Strike, OptionType or TickSize columns; replay is blocked');
 const underlying=String(optionDataset.underlying).replace(/^NSE:/,'').replace(/-(EQ|INDEX)$/,'').toUpperCase();
 const targetExpiry=nseDate(optionDataset.expiry);
 const matches=rows.slice(1).filter(row=>
  String(row[columns.symbol]||'').trim().toUpperCase()===underlying&&
  nseDate(row[columns.expiry])===targetExpiry&&
  Math.abs(Number(row[columns.strike])-Number(optionDataset.strike))<1e-8&&
  String(row[columns.side]||'').trim().toUpperCase()===String(optionDataset.side).toUpperCase()
 );
 if(matches.length!==1)throw new Error('Exact underlying/expiry/strike/option-side contract row is missing or duplicated in the official NSE daily master');
 const masterTick=Number(matches[0][columns.tick]);
 if(!Number.isFinite(masterTick)||masterTick<=0||Math.abs(masterTick-Number(spec.tickSize))>1e-8)throw new Error('Historical option tick size does not match the exact contract row in the official NSE daily master');
 return true;
}

async function readVerified(root,name,expected,label){
 const file=filename(name),bytes=await readFile(path.join(root,file));
 if(!/^[a-f0-9]{64}$/.test(expected||'')||sha(bytes)!==expected)throw new Error(label+' SHA-256 mismatch');
 return JSON.parse(bytes.toString('utf8'));
}
/** Isolated offline worker: no FYERS client, REST governor, WebSocket, server, scanner, account or order imports. */
export async function runOfflineOptionExecutionDataset({inputDir,outputDir}={}){
 if(!inputDir||!outputDir)throw new Error('Separate inputDir and outputDir are required');
 const input=path.resolve(inputDir),output=path.resolve(outputDir);
 if(input===output||output.startsWith(input+path.sep)||input.startsWith(output+path.sep))throw new Error('Option replay input and output directories must be separate and non-overlapping');
 const manifest=JSON.parse((await readFile(path.join(input,'manifest.json'))).toString('utf8'));
 if(manifest.format!==FORMAT||manifest.source!=='FYERS_EXPIRED_FO_API'||manifest.actionable!==false||manifest.ordersEnabled!==false)throw new Error('Option replay manifest must identify non-actionable FYERS expired-F&O evidence');
 if(manifest.complete!==true||Number(manifest.failureCount)!==0||!Array.isArray(manifest.entries)||manifest.entries.length<1||manifest.entries.length>3000)throw new Error('Option replay manifest is incomplete or has failed exports');
 const results=[];
 for(const entry of manifest.entries){
  const signal=await readVerified(input,entry.signalFile,entry.signalSha256,'Underlying signal');
  const optionDataset=await readVerified(input,entry.optionFile,entry.optionSha256,'Expired option data');
  const contractSpec=await readVerified(input,entry.contractSpecFile,entry.contractSpecSha256,'Historical contract specification');
  const masterName=masterFilename(contractSpec.masterFile);
  const masterBytes=await readFile(path.join(input,masterName));
  if(!/^[a-f0-9]{64}$/.test(contractSpec.masterFileSha256||'')||sha(masterBytes)!==contractSpec.masterFileSha256||contractSpec.sha256!==contractSpec.masterFileSha256)throw new Error('Official NSE daily F&O contract-master SHA-256 mismatch');
  verifyContractMaster(masterBytes,contractSpec,optionDataset);
  contractSpec.masterRowVerified=true;
  const topGainerMembership=entry.topGainerFile?await readVerified(input,entry.topGainerFile,entry.topGainerSha256,'Top Gainer membership'):[];
  optionDataset.integrityVerified=true;
  const result=simulateExpiredOptionSignal({signal,optionDataset,contractSpec,topGainerMembership});
  results.push({signalId:String(entry.signalId||signal.strategy+':'+signal.symbol+':'+signal.confirmedAt),...result,actionable:false,ordersEnabled:false});
 }
 const summary=summarizeExpiredOptionReplay(results);
 const report={
  status:summary.status,format:'UPGRADE_AI_PRO_OPTION_EXECUTION_RESULTS_V1',
  mode:'OFFLINE_EXPIRED_OPTION_CANDLE_PROXY_REPLAY',source:'FYERS_EXPIRED_FO_API',
  datasetId:String(manifest.datasetId||'UNSPECIFIED'),generatedAt:new Date().toISOString(),
  actionable:false,ordersEnabled:false,liveStateTouched:false,
  performanceClass:'GROSS_CANDLE_PROXY_NOT_EXECUTABLE',
  summary,results
 };
 await mkdir(output,{recursive:true});
 const target=path.join(output,'option-replay-'+Date.now()+'.json'),temporary=target+'.tmp';
 await writeFile(temporary,JSON.stringify(report,null,2),{flag:'wx'});
 await rename(temporary,target);
 return {path:target,report};
}

if(process.argv[1]&&path.resolve(process.argv[1])===path.resolve(new URL(import.meta.url).pathname)){
 const [inputDir,outputDir]=process.argv.slice(2);
 runOfflineOptionExecutionDataset({inputDir,outputDir})
  .then(({path:resultPath,report})=>{
   process.stdout.write(JSON.stringify({status:report.status,resultPath,sampleCount:report.summary.sampleCount,winRate:report.summary.winRate,performanceClass:report.performanceClass,actionable:false,ordersEnabled:false})+'\\n');
   if(report.status!=='COMPLETE')process.exitCode=2;
  })
  .catch(error=>{
   process.stderr.write(JSON.stringify({status:'DATA_UNAVAILABLE',reason:String(error?.message||error).slice(0,300),actionable:false,ordersEnabled:false})+'\\n');
   process.exitCode=1;
  });
}
