import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import path from 'node:path';
import { simulateExpiredOptionSignal, summarizeExpiredOptionReplay } from './backtest-option-execution.js';

const FORMAT='UPGRADE_AI_PRO_OPTION_EXECUTION_DATASET_V1';
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
function filename(value){
 if(typeof value!=='string'||!/^[A-Za-z0-9._-]{1,120}\.json$/.test(value)||value.includes('..'))throw new Error('Offline option dataset filename is invalid');
 return value;
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
  const masterName=filename(contractSpec.masterFile);
  const masterBytes=await readFile(path.join(input,masterName));
  if(!/^[a-f0-9]{64}$/.test(contractSpec.masterFileSha256||'')||sha(masterBytes)!==contractSpec.masterFileSha256||contractSpec.sha256!==contractSpec.masterFileSha256)throw new Error('Official NSE daily F&O contract-master SHA-256 mismatch');
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
