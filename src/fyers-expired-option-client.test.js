import test from 'node:test';
import assert from 'node:assert/strict';
import { createFyersExpiredOptionClient, FYERS_EXPIRED_OPTION_ENDPOINTS } from './fyers-expired-option-client.js';

test('FYERS expired option adapter uses only the three official read-only expired-F&O GET endpoints',async()=>{
  const calls=[];
  const fetchImpl=async(url,options)=>{
    calls.push({url:new URL(url),options});
    return {ok:true,status:200,text:async()=>JSON.stringify({s:'ok',data:{}})};
  };
  const client=createFyersExpiredOptionClient({appId:'APP-100',accessToken:'secret-token',fetchImpl});
  await client.expiry_dates({symbol:'NSE:SBIN-EQ',range_from:'2025-01-01',range_to:'2025-01-31',date_format:'1'});
  await client.history_underlying_symbols({symbol:'NSE:SBIN-EQ',expiry_date:'2025-01-30'});
  await client.fno_historical_data({symbol:'NSE:SBIN25JAN800CE',resolution:'5',date_format:'1',range_from:'2025-01-01',range_to:'2025-01-30',include_oi:'0',include_greeks:'0'});
  assert.deepEqual(calls.map(x=>x.url.pathname),[
    '/data'+FYERS_EXPIRED_OPTION_ENDPOINTS.expiryDates,
    '/data'+FYERS_EXPIRED_OPTION_ENDPOINTS.expiredContracts,
    '/data'+FYERS_EXPIRED_OPTION_ENDPOINTS.expiredHistory
  ]);
  assert.ok(calls.every(x=>x.options.method==='GET'));
  assert.ok(calls.every(x=>x.options.headers.Authorization==='APP-100:secret-token'));
  assert.ok(calls.every(x=>!x.url.href.includes('secret-token')));
  assert.equal(calls[2].url.searchParams.get('include_oi'),'0');
  assert.equal(calls[2].url.searchParams.get('include_greeks'),'0');
});

test('FYERS expired option adapter rejects missing credentials and non-JSON responses',async()=>{
  assert.throws(()=>createFyersExpiredOptionClient({appId:'',accessToken:'x'}),/required/);
  const client=createFyersExpiredOptionClient({
    appId:'APP-100',accessToken:'token',
    fetchImpl:async()=>({ok:true,status:200,text:async()=>'not-json'})
  });
  await assert.rejects(()=>client.expiry_dates({symbol:'NSE:SBIN-EQ'}),/non-JSON/);
});

test('FYERS expired option adapter surfaces provider HTTP failures without retrying',async()=>{
  let calls=0;
  const client=createFyersExpiredOptionClient({
    appId:'APP-100',accessToken:'token',
    fetchImpl:async()=>{calls++;return{ok:false,status:429,text:async()=>JSON.stringify({s:'error',message:'rate limited'})};}
  });
  await assert.rejects(()=>client.expiry_dates({symbol:'NSE:SBIN-EQ'}),/HTTP 429/);
  assert.equal(calls,1);
});
