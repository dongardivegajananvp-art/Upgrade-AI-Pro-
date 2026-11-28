import test from 'node:test';
import assert from 'node:assert/strict';
import { buildFnoEquityUniverse, verifyOptionContractRow } from './fyers-symbol-master.js';

test('maps active F&O underlyings using official NSE cash ticker', () => {
  const now = Date.UTC(2026, 10, 19, 4, 0);
  const expiry = String(Math.floor((now + 7 * 86400000) / 1000));
  const fo = {
    'NSE:SBIN26NOV1000CE': { symTicker:'NSE:SBIN26NOV1000CE', optType:'CE', expiryDate:expiry, underSym:'SBIN', tradeStatus:1 },
    'NSE:SBIN26NOV1000PE': { symTicker:'NSE:SBIN26NOV1000PE', optType:'PE', expiryDate:expiry, underSym:'SBIN', tradeStatus:1 },
    'NSE:OLD26NOV1000CE': { symTicker:'NSE:OLD26NOV1000CE', optType:'CE', expiryDate:'1000000000', underSym:'OLD', tradeStatus:1 },
    'NSE:HALF26NOV1000CE': { symTicker:'NSE:HALF26NOV1000CE', optType:'CE', expiryDate:expiry, underSym:'HALF', tradeStatus:0 }
  };
  const cm = {
    'NSE:SBIN-EQ': { symTicker:'NSE:SBIN-EQ', fyToken:'101', symDetails:'STATE BANK OF INDIA', tradeStatus:1 },
    'NSE:OLD-EQ': { symTicker:'NSE:OLD-EQ', fyToken:'102', tradeStatus:1 }
  };
  const result = buildFnoEquityUniverse(fo, cm, now);
  assert.deepEqual(result.universe.map(row=>row.symbol), ['NSE:SBIN-EQ']);
  assert.equal(result.diagnostics.activeOptionContracts, 2);
});
test('keeps contracts expiring today valid through the IST expiry day', () => {
  const now = Date.UTC(2026, 10, 19, 5, 0);
  const expiryMidnight = String(Math.floor(Date.UTC(2026, 10, 18, 18, 30) / 1000));
  const fo = { 'NSE:SBIN26NOV1000CE': { symTicker:'NSE:SBIN26NOV1000CE', optType:'CE', expiryDate:expiryMidnight, underSym:'SBIN' } };
  const cm = { 'NSE:SBIN-EQ': { symTicker:'NSE:SBIN-EQ', fyToken:'101' } };
  const result = buildFnoEquityUniverse(fo, cm, now);
  assert.equal(result.universe.length, 1);
});


test('rejects official master rows whose ticker suffix conflicts with CE/PE metadata', () => {
  const now=Date.parse('2026-11-19T09:00:00+05:30');
  const expiry=String(Math.floor((now+7*86400000)/1000));
  const row={symTicker:'NSE:SBIN26NOV1000CE',optType:'PE',underSym:'SBIN',expiryDate:expiry,
    minLotSize:750,tickSize:0.05,strikePrice:1000,fyToken:'12345',tradeStatus:1};
  assert.throws(()=>verifyOptionContractRow(row,row.symTicker,now),/symbol and CE\/PE identity/i);
});

test('verifies option underlying, expiry, side, strike, lot size, tick size and FY token from official master', () => {
  const now=Date.UTC(2026,10,19,4,0);
  const expiry=String(Math.floor((now+7*86400000)/1000));
  const row={symTicker:'NSE:SBIN26NOV1000CE',optType:'CE',underSym:'SBIN',expiryDate:expiry,minLotSize:750,tickSize:0.05,strikePrice:1000,fyToken:'12345',tradeStatus:1};
  const contract=verifyOptionContractRow(row,row.symTicker,now);
  assert.equal(contract.underlying,'SBIN');
  assert.equal(contract.side,'CE');
  assert.equal(contract.strike,1000);
  assert.equal(contract.lotSize,750);
  assert.equal(contract.tickSize,0.05);
  assert.equal(contract.fyToken,'12345');
});

test('fails closed for invalid FYERS option master lot, tick, strike, token or inactive contract', () => {
  const now=Date.UTC(2026,10,19,4,0);
  const expiry=String(Math.floor((now+7*86400000)/1000));
  const base={symTicker:'NSE:SBIN26NOV1000CE',optType:'CE',underSym:'SBIN',expiryDate:expiry,minLotSize:750,tickSize:0.05,strikePrice:1000,fyToken:'12345',tradeStatus:1};
  for(const patch of [{minLotSize:0},{tickSize:0},{strikePrice:0},{fyToken:''},{tradeStatus:0},{underSym:''}]) {
    assert.throws(()=>verifyOptionContractRow({...base,...patch},base.symTicker,now));
  }
});
