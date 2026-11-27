import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import net from 'node:net';

async function reservePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const { port } = server.address();
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  return port;
}

test('POST /api/orders rejects unauthenticated requests before broker order handling', async () => {
  const port = await reservePort();
  const child = spawn(process.execPath, ['server.js'], {
    cwd: process.cwd(),
    env: { ...process.env, PORT: String(port) },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let output = '';
  child.stdout.setEncoding('utf8').on('data', chunk => { output += chunk; });
  child.stderr.setEncoding('utf8').on('data', chunk => { output += chunk; });

  try {
    const deadline = Date.now() + 10000;
    let response;
    while (Date.now() < deadline) {
      if (child.exitCode !== null) throw new Error('Server exited before readiness: ' + output);
      try {
        response = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(500) });
        if (response.ok) break;
      } catch {}
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert.ok(response?.ok, 'server must become healthy before order-route assertion: ' + output);

    const order = await fetch(`http://127.0.0.1:${port}/api/orders`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ symbol: 'NSE:TEST-EQ', side: 'BUY', quantity: 1 })
    });
    assert.equal(order.status, 401);
    const body = await order.json();
    assert.equal(body.status, 'AUTHENTICATION_REQUIRED');
    assert.match(body.reason, /valid Upgrade AI Pro FYERS session is required/);
  } finally {
    child.kill('SIGTERM');
    await new Promise(resolve => {
      if (child.exitCode !== null) return resolve();
      child.once('exit', resolve);
      setTimeout(resolve, 2000).unref();
    });
  }
});
