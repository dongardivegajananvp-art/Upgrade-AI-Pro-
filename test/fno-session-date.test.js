import test from 'node:test';
import assert from 'node:assert/strict';
import { getNseSessionDate } from '../src/fyers-symbol-master.js';

test('official NSE master refresh date follows the Asia/Kolkata calendar boundary', () => {
  assert.equal(getNseSessionDate(Date.parse('2026-11-19T18:29:59Z')), '2026-11-19');
  assert.equal(getNseSessionDate(Date.parse('2026-11-19T18:30:00Z')), '2026-11-20');
});
