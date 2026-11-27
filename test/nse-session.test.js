import test from 'node:test';
import assert from 'node:assert/strict';
import { isNseRegularSession, isNseSignalWindow } from '../src/nse-session.js';

test('NSE session opens at 09:15 IST on weekdays', () => {
  assert.equal(isNseRegularSession(Date.parse('2026-11-23T03:45:00.000Z')), true);
  assert.equal(isNseRegularSession(Date.parse('2026-11-23T04:00:00.000Z')), true);
});

test('NSE session is closed before open and at/after 15:30 IST', () => {
  assert.equal(isNseRegularSession(Date.parse('2026-11-23T03:44:59.999Z')), false);
  assert.equal(isNseRegularSession(Date.parse('2026-11-23T10:00:00.000Z')), false);
});

test('NSE session is closed on weekends', () => {
  assert.equal(isNseRegularSession(Date.parse('2026-11-21T05:00:00.000Z')), false);
  assert.equal(isNseRegularSession(Date.parse('2026-11-22T05:00:00.000Z')), false);
});

test('invalid timestamps fail closed', () => {
  assert.equal(isNseRegularSession(NaN), false);
  assert.equal(isNseRegularSession(0), false);
});


test('signal generation runs only from 09:30 through 12:00 IST on weekdays', () => {
  assert.equal(isNseSignalWindow(Date.parse('2026-11-23T03:59:59.999Z')), false);
  assert.equal(isNseSignalWindow(Date.parse('2026-11-23T04:00:00.000Z')), true);
  assert.equal(isNseSignalWindow(Date.parse('2026-11-23T06:29:59.999Z')), true);
  assert.equal(isNseSignalWindow(Date.parse('2026-11-23T06:30:00.000Z')), false);
  assert.equal(isNseSignalWindow(Date.parse('2026-11-21T05:00:00.000Z')), false);
  assert.equal(isNseSignalWindow(NaN), false);
});
