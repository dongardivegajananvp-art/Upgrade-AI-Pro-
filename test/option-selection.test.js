import test from 'node:test';
import assert from 'node:assert/strict';
import { chooseDirectionalOption } from '../src/option-selection.js';
import { verifyOptionContractRow } from '../src/fyers-symbol-master.js';

const now = Date.parse('2026-11-19T06:00:00Z');
const base = {
  symTicker:'NSE:ABC26NOV100CE', optType:'CE', tradeStatus:1,
  expiryDate:Date.parse('2026-11-26T10:00:00Z')/1000,
  minLotSize:25, tickSize:0.05, strikePrice:100,
  underSym:'ABC', fyToken:'123456'
};

test('LONG selects CE and SHORT selects PE at nearest ATM in requested chain', () => {
  const chain=[
    {option_type:'CE',symbol:'NSE:ABC26NOV100CE',strike_price:100},
    {option_type:'CE',symbol:'NSE:ABC26NOV105CE',strike_price:105},
    {option_type:'PE',symbol:'NSE:ABC26NOV100PE',strike_price:100},
    {option_type:'PE',symbol:'NSE:ABC26NOV95PE',strike_price:95}
  ];
  assert.equal(chooseDirectionalOption({optionsChain:chain,underlyingPrice:102,side:'LONG'}).symbol,'NSE:ABC26NOV100CE');
  assert.equal(chooseDirectionalOption({optionsChain:chain,underlyingPrice:98,side:'SHORT'}).symbol,'NSE:ABC26NOV100PE');
  assert.equal(chooseDirectionalOption({optionsChain:chain,underlyingPrice:100,side:'LONG'}).side,'CE');
  assert.equal(chooseDirectionalOption({optionsChain:chain,underlyingPrice:100,side:'SHORT'}).side,'PE');
});

test('official master verifies exact expiry, strike, lot size, tick size and FY token fields', () => {
  const verified=verifyOptionContractRow(base,base.symTicker,now);
  assert.deepEqual(
    {symbol:verified.symbol,side:verified.side,underlying:verified.underlying,strike:verified.strike,lotSize:verified.lotSize,tickSize:verified.tickSize,fyToken:verified.fyToken},
    {symbol:base.symTicker,side:'CE',underlying:'ABC',strike:100,lotSize:25,tickSize:0.05,fyToken:'123456'}
  );
  assert.ok(verified.expiry>now/1000);
});

test('official master rejects expired, inactive or incomplete option contracts', () => {
  assert.throws(()=>verifyOptionContractRow({...base,expiryDate:Date.parse('2026-11-18T10:00:00Z')/1000},base.symTicker,now),/expiry/i);
  assert.throws(()=>verifyOptionContractRow({...base,tradeStatus:0},base.symTicker,now),/inactive/i);
  assert.throws(()=>verifyOptionContractRow({...base,minLotSize:0},base.symTicker,now),/invalid/i);
  assert.throws(()=>verifyOptionContractRow({...base,tickSize:0},base.symTicker,now),/invalid/i);
  assert.throws(()=>verifyOptionContractRow({...base,fyToken:''},base.symTicker,now),/invalid/i);
  assert.throws(()=>verifyOptionContractRow({...base,strikePrice:0},base.symTicker,now),/invalid/i);
  assert.throws(()=>verifyOptionContractRow({...base,optType:'XX'},base.symTicker,now),/official FYERS/i);
});
