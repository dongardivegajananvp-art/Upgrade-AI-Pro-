import test from 'node:test';
import assert from 'node:assert/strict';
import { requiresFyersSession } from './api-access.js';

test('broker-backed endpoints require a verified FYERS session', () => {
  for (const path of [
    '/api/history',
    '/api/research',
    '/api/research/universe',
    '/api/quotes',
    '/api/option-chain',
    '/api/positions',
    '/api/orderbook',
    '/api/select-underlying',
    '/api/select-option',
    '/api/auto-select-option',
    '/api/evaluate-setup',
    '/api/orders'
  ]) assert.equal(requiresFyersSession(path), true, path);
});

test('only safe market/status views and OAuth entry routes are public', () => {
  for (const path of [
    '/api/market-data',
    '/api/status',
    '/api/fyers/login',
    '/api/fyers/auth/callback'
  ]) assert.equal(requiresFyersSession(path), false, path);
  assert.equal(requiresFyersSession('/'), false);
  assert.equal(requiresFyersSession('/assets/app.js'), false);
});
