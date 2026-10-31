import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/app.js';
import { readConfig } from '../src/config.js';
const baseEnv = { NODE_ENV: 'test', CLIENT_ORIGIN: 'http://localhost:3000' };
test('environment validation', () => {
  for (const patch of [{ PORT: '0' }, { PORT: 'abc' }, { NODE_ENV: 'unknown' }, { CLIENT_ORIGIN: '*' }, { CLIENT_ORIGIN: 'https://example.com/' }, { MONGODB_URI: 'invalid', MONGODB_DB_NAME: 'test' }, { MONGODB_URI: 'mongodb://localhost:27017' }, { NODE_ENV: 'production', CLIENT_ORIGIN: 'https://example.com' }, { NODE_ENV: 'production', CLIENT_ORIGIN: 'http://example.com' }]) {
    assert.throws(() => readConfig({ ...baseEnv, ...patch }));
  }
  assert.equal(readConfig(baseEnv).port, 5000);
  assert.doesNotThrow(() => readConfig({ ...baseEnv, NODE_ENV: 'production', CLIENT_ORIGIN: 'https://example.com', MONGODB_URI: 'mongodb://localhost:27017', MONGODB_DB_NAME: 'test' }));
});
test('HTTP health, CORS, security headers, limits and safe errors', async t => {
  const server = createApp(readConfig(baseEnv)).listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const url = `http://127.0.0.1:${server.address().port}`;
  const health = await fetch(`${url}/api/health`, { headers: { Origin: baseEnv.CLIENT_ORIGIN } });
  assert.equal(health.status, 200);
  assert.deepEqual(await health.json(), { status: 'ok' });
  assert.equal(health.headers.get('access-control-allow-origin'), baseEnv.CLIENT_ORIGIN);
  assert.equal(health.headers.get('x-powered-by'), null);
  assert.equal(health.headers.get('x-content-type-options'), 'nosniff');
  const denied = await fetch(`${url}/api/health`, { headers: { Origin: 'https://unapproved.example' } });
  assert.equal(denied.status, 403);
  assert.equal(denied.headers.get('access-control-allow-origin'), null);
  const preflight = await fetch(`${url}/api/health`, { method: 'OPTIONS', headers: { Origin: baseEnv.CLIENT_ORIGIN, 'Access-Control-Request-Method': 'GET' } });
  assert.equal(preflight.status, 204);
  assert.equal((await fetch(`${url}/missing`)).status, 404);
  assert.equal((await fetch(`${url}/api/readiness`)).status, 404);
  const invalid = await fetch(`${url}/api/health`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{' });
  assert.equal(invalid.status, 400);
  assert.deepEqual(await invalid.json(), { error: 'Invalid request' });
  const oversized = await fetch(`${url}/api/health`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ value: 'a'.repeat(17000) }) });
  assert.equal(oversized.status, 413);
});
