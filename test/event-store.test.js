import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { createEventStore } from '../src/event-store.js';
import { createRuntime } from '../src/runtime.js';

const config = { nodeEnv: 'test', mongoUri: 'mongodb://unused.invalid', dbName: 'noblenest', origins: ['http://localhost:3000'] };

test('event store reuses one lazy bounded client and only nn_events, never initializing indexes', async () => {
  const calls = []; let instances = 0;
  class Client {
    constructor(uri, options) { instances++; assert.equal(uri, config.mongoUri); calls.push({ options }); }
    db(name) { assert.equal(name, 'noblenest'); return { collection(name) {
      assert.equal(name, 'nn_events'); return { async findOne() { calls.push('read'); return null; } };
    } }; }
    async close() { calls.push('close'); }
  }
  const store = createEventStore(config, { Client });
  assert.equal(calls.length, 1); assert.equal(instances, 1);
  assert.deepEqual(calls[0].options, { maxPoolSize: 5, minPoolSize: 0, serverSelectionTimeoutMS: 5000, connectTimeoutMS: 5000, socketTimeoutMS: 10000, waitQueueTimeoutMS: 5000, timeoutMS: 10000 });
  for (let index = 0; index < 3; index++) assert.equal(await store.repository.findEventById('000000000000000000000001'), null);
  assert.equal(instances, 1);
  await Promise.all([store.close(), store.close()]); assert.equal(calls.filter(call => call === 'close').length, 1);
});

test('events require the NobleNest database and fail closed in production; empty development is allowed', async () => {
  class NoClient { constructor() { assert.fail('must validate before creating a client'); } }
  for (const patch of [{ dbName: 'wanderlust' }, { dbName: '' }, { mongoUri: '' }, { mongoUri: '', dbName: '', nodeEnv: 'production' }]) assert.throws(() => createEventStore({ ...config, ...patch }, { Client: NoClient }));
  const store = createEventStore({ ...config, mongoUri: '', dbName: '' }, { Client: NoClient });
  assert.equal(store.repository, undefined); await store.close();
});

test('runtime closes both pools once even if one rejects and cleans partial startup failures', async () => {
  const closed = [];
  const runtime = await createRuntime(config, {
    eventStoreFactory: () => ({ close() { closed.push('events'); throw Error('private driver detail'); } }),
    authorizationFactory: () => ({ close() { closed.push('auth'); } }),
  });
  await assert.rejects(runtime.close(), { message: 'Resource shutdown failed.' });
  await assert.rejects(runtime.close(), { message: 'Resource shutdown failed.' });
  assert.deepEqual(closed, ['events', 'auth']);
  let cleanup = 0;
  await assert.rejects(createRuntime(config, {
    eventStoreFactory: () => ({ close() { cleanup++; } }),
    authorizationFactory: () => { throw Error('private startup detail'); },
  }), { message: 'Server resource initialization failed.' });
  assert.equal(cleanup, 1);
});

test('isolated runtime starts normally without database access and closes gracefully', async t => {
  let closed = 0;
  const runtime = await createRuntime(config, {
    eventStoreFactory: () => ({ repository: { async listUpcomingEvents() { return []; } }, close: async () => { closed++; } }),
    authorizationFactory: () => ({ close: async () => { closed++; } }),
  });
  const server = runtime.app.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => { await new Promise(resolve => server.close(resolve)); await runtime.close(); });
  const base = `http://127.0.0.1:${server.address().port}`;
  assert.equal((await fetch(`${base}/api/health`)).status, 200);
  assert.deepEqual(await (await fetch(`${base}/api/events/upcoming`)).json(), { events: [] });
  await runtime.close(); assert.equal(closed, 2);
});

test('index plan is offline, matches approved indexes and refuses execution flags', async () => {
  async function run(args) {
    const child = spawn(process.execPath, ['scripts/event-indexes-plan.js', ...args], { cwd: new URL('../', import.meta.url), stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = ''; child.stdout.on('data', chunk => { stdout += chunk; }); child.stderr.on('data', chunk => { stderr += chunk; });
    const [code] = await once(child, 'close'); return { code, stdout, stderr };
  }
  const plan = await run([]); assert.equal(plan.code, 0);
  const parsed = JSON.parse(plan.stdout); assert.equal(parsed.collection, 'nn_events');
  assert.deepEqual(parsed.indexes.map(index => index.name), ['events_upcoming_date_id', 'events_creator_date_id']);
  assert.equal(parsed.builtIn, '_id_'); assert.match(parsed.execution, /Not performed/);
  const refused = await run(['--apply']); assert.equal(refused.code, 1); assert.equal(refused.stdout, '');
});

test('real server entry point exits safely on listen failure without reading credentials', { timeout: 15000 }, async t => {
  const occupied = createServer().listen(0, '0.0.0.0'); await once(occupied, 'listening');
  t.after(() => new Promise(resolve => occupied.close(resolve)));
  const env = { ...process.env, NODE_ENV: 'test', PORT: String(occupied.address().port), CLIENT_ORIGIN: config.origins[0] };
  for (const key of Object.keys(env)) if (/^(MONGODB_|AUTH_JWT_|AUTH_JWKS_)/i.test(key)) delete env[key];
  // No --env-file argument: the child cannot load private local configuration.
  const child = spawn(process.execPath, ['src/server.js'], { cwd: new URL('../', import.meta.url), env, stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(() => { if (child.exitCode === null) child.kill(); });
  let output = ''; child.stdout.on('data', chunk => { output += chunk; }); child.stderr.on('data', chunk => { output += chunk; });
  const [code] = await once(child, 'close');
  assert.equal(code, 1); assert.equal(output.trim(), 'API startup failed');
});
