import test from 'node:test';
import assert from 'node:assert/strict';
import { chooseDirectionalOption, verifyOptionContractUnderlying } from './option-selection.js';

const chain = [
  { symbol: 'NSE:ABC100CE', option_type: 'CE', strike_price: 100 },
  { symbol: 'NSE:ABC105CE', option_type: 'CE', strike_price: 105 },
  { symbol: 'NSE:ABC100PE', option_type: 'PE', strike_price: 100 },
  { symbol: 'NSE:ABC105PE', option_type: 'PE', strike_price: 105 }
];

test('LONG underlying selects nearest-ATM CE only', () => {
  const result = chooseDirectionalOption({ optionsChain: chain, underlyingPrice: 104, side: 'LONG' });
  assert.equal(result.status, 'CANDIDATE_SELECTED');
  assert.equal(result.side, 'CE');
  assert.equal(result.strike, 105);
  assert.equal(result.actionable, false);
});

test('SHORT underlying selects nearest-ATM PE only', () => {
  const result = chooseDirectionalOption({ optionsChain: chain, underlyingPrice: 101, side: 'SHORT' });
  assert.equal(result.side, 'PE');
  assert.equal(result.strike, 100);
});

test('selection fails closed without direction, price or matching chain contracts', () => {
  assert.equal(chooseDirectionalOption({ optionsChain: chain, underlyingPrice: 100 }).status, 'UNAVAILABLE');
  assert.equal(chooseDirectionalOption({ optionsChain: chain, underlyingPrice: 0, side: 'LONG' }).status, 'UNAVAILABLE');
  assert.equal(chooseDirectionalOption({ optionsChain: [], underlyingPrice: 100, side: 'LONG' }).status, 'UNAVAILABLE');
});


test('official contract identity is verified independently of live tick freshness', () => {
  const contract = { symbol: 'NSE:ABC105CE', underlying: 'ABC', side: 'CE', strike: 105 };
  assert.equal(verifyOptionContractUnderlying(contract, 'NSE:ABC-EQ').status, 'CONTRACT_IDENTITY_VERIFIED');
  assert.equal(verifyOptionContractUnderlying(contract, null).status, 'UNDERLYING_NOT_SELECTED');
  assert.equal(verifyOptionContractUnderlying(contract, 'NSE:XYZ-EQ').status, 'UNDERLYING_MISMATCH');
});
