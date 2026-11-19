import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const [app, css, html, manifest, serviceWorker] = await Promise.all([
  readFile(new URL('../public/app.js', import.meta.url), 'utf8'),
  readFile(new URL('../public/style.css', import.meta.url), 'utf8'),
  readFile(new URL('../public/index.html', import.meta.url), 'utf8'),
  readFile(new URL('../public/manifest.webmanifest', import.meta.url), 'utf8').then(JSON.parse),
  readFile(new URL('../public/sw.js', import.meta.url), 'utf8')
]);

test('top five gainer cards expose direction and stale-state styling', () => {
  for (const state of ['up', 'down', 'flat', 'stale']) {
    assert.ok(css.includes('.mover-card[data-state="' + state + '"]'));
  }
  assert.match(app, /button\.dataset\.state = cardState/);
  assert.match(app, /change\.dataset\.state = item\.fresh \? direction : 'stale'/);
});

test('verified option entry, stop and target are rendered as labelled chart arrows', () => {
  for (const label of ['OPTION ENTRY', 'OPTION STOP LOSS', 'OPTION TARGET']) {
    assert.ok(app.includes(label));
  }
  assert.match(app, /chartSetupLevels = \{ entry: Number\(setup\.entry\), stopLoss: Number\(setup\.stopLoss\), target: Number\(setup\.target\) \}/);
  assert.match(app, /These levels are option-premium prices, not underlying-share prices/);
});

test('PWA supports standalone desktop/mobile layout and responsive breakpoints', () => {
  assert.equal(manifest.display, 'standalone');
  assert.ok(manifest.display_override.includes('standalone'));
  assert.ok(html.includes('viewport-fit=cover'));
  assert.ok(css.includes('@media(min-width:1200px)'));
  assert.ok(css.includes('@media(min-width:701px) and (max-width:1100px)'));
  assert.ok(css.includes('@media(max-width:700px)'));
  assert.match(serviceWorker, /upgrade-ai-pro-shell-v8/);
});
