import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ObjectId } from 'mongodb';
import { createApp } from '../src/app.js';
import { createEventRepository } from '../src/event-repository.js';

const now = new Date('2030-01-01T00:00:00.000Z');
const config = { origins: ['http://localhost:3000'] };
const id = number => number.toString(16).padStart(24, '0');
function document(number, milliseconds = 1000) {
  return { _id: new ObjectId(id(number)), title: `Isolated item ${number}`,
    description: 'In-memory HTTP test only.', eventType: 'Cleanup',
    thumbnailUrl: 'https://example.invalid/image.webp', thumbnailAlt: 'Test image',
    location: 'Test location', eventDate: new Date(+now + milliseconds),
    creatorId: 'verified-creator', createdAt: now, updatedAt: now,
    privateDriverMetadata: 'must not escape' };
}

// Only read operations exist in this double; no live MongoDB or inserts.
function collection(documents = []) {
  const calls = [];
  return {
    calls,
    async findOne(filter, options) {
      calls.push({ filter, options });
      return documents.find(item => item._id.equals(filter._id)) ?? null;
    },
    find(filter, options) {
      const call = { filter, options }; calls.push(call);
      return {
        sort(value) { call.sort = value; return this; },
        skip(value) { call.skip = value; return this; },
        limit(value) { call.limit = value; return this; },
        async toArray() {
          assert.deepEqual(call.sort, { eventDate: 1, _id: 1 });
          return documents.filter(item => item.eventDate > filter.eventDate.$gt)
            .sort((a, b) => a.eventDate - b.eventDate || a._id.toHexString().localeCompare(b._id.toHexString()))
            .slice(call.skip, call.skip + call.limit);
        },
      };
    },
  };
}
async function serve(t, repository, authorization) {
  const server = createApp(config, authorization, repository).listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  return (path, options) => fetch(`http://127.0.0.1:${server.address().port}${path}`, options);
}

test('public empty listings use consistent event envelopes without authentication', async t => {
  const db = collection(); const request = await serve(t, createEventRepository(db, { now: () => now }));
  const response = await request('/api/events');
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { events: [], pagination: { page: 1, pageSize: 6 } });
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.deepEqual(await (await request('/api/events/upcoming')).json(), { events: [] });
});

test('HTTP upcoming feed excludes current/past dates, orders date/ID, caps six and routes before :id', async t => {
  const docs = [document(20, -1), document(21, 0), ...Array.from({ length: 10 }, (_, index) => document(10 - index, index < 2 ? 1000 : 2000))];
  const db = collection(docs); const request = await serve(t, createEventRepository(db, { now: () => now }));
  const result = await request('/api/events/upcoming'); assert.equal(result.status, 200);
  const { events } = await result.json();
  assert.deepEqual(events.map(event => event.id), [id(9), id(10), id(1), id(2), id(3), id(4)]);
  assert.equal(events.length, 6);
  assert.equal(db.calls[0].skip, 0); assert.equal(db.calls[0].limit, 6);
  assert.deepEqual(db.calls[0].filter, { eventDate: { $gt: now } });
  assert.equal(db.calls[0].options.projection.privateDriverMetadata, undefined);
  assert.equal(JSON.stringify(events).includes('privateDriverMetadata'), false);
  const second = await (await request('/api/events?page=2')).json();
  assert.deepEqual(second.events.map(event => event.id), [id(5), id(6), id(7), id(8)]);
  assert.deepEqual(second.pagination, { page: 2, pageSize: 6 });
});

test('homepage calls approved repository with zero arguments; page requests use bounded numeric page', async t => {
  const calls = [];
  const request = await serve(t, { async listUpcomingEvents(...args) { calls.push(args); return []; } });
  for (const path of ['/api/events/upcoming', '/api/events?page=1', '/api/events?page=1000']) assert.equal((await request(path)).status, 200);
  assert.deepEqual(calls, [[], [{ page: 1 }], [{ page: 1000 }]]);
});

test('query boundaries and malformed/duplicate/nested/filter parameters fail before database access', async t => {
  const db = collection(); const request = await serve(t, createEventRepository(db));
  const queries = ['page=0', 'page=1001', 'page=-1', 'page=1.5', 'page=1e2', 'page=01', 'page=', 'page=%20', 'page=NaN', 'page=999999999999999999999', 'page=1&page=2', 'page=1&%70age=1', 'page[]=1', 'page[$gt]=1', 'pageSize=6', 'limit=6', 'offset=0', 'sort=eventDate', 'creatorId=user', '$where=malicious', '__proto__=x', 'page=%FF', 'page=%ZZ'];
  for (const query of queries) {
    const response = await request(`/api/events?${query}`);
    assert.equal(response.status, 400, query);
    assert.deepEqual(await response.json(), { error: 'Invalid event query.' });
  }
  for (const path of ['/api/events/upcoming?page=1', '/api/events/upcoming?limit=6', `/api/events/${id(1)}?page=1`, `/api/events/${id(1)}?unknown=x`]) assert.equal((await request(path)).status, 400);
  assert.equal(db.calls.length, 0);
});

test('details return approved DTO only, malformed ID is 400, missing valid ID is 404', async t => {
  const db = collection([document(1)]); const request = await serve(t, createEventRepository(db));
  const response = await request(`/api/events/${id(1)}`); assert.equal(response.status, 200);
  const { event } = await response.json();
  assert.equal(event.id, id(1)); assert.equal(event.eventDate, '2030-01-01T00:00:01.000Z');
  assert.deepEqual(Object.keys(event).sort(), ['id', 'title', 'description', 'eventType', 'thumbnailUrl', 'thumbnailAlt', 'location', 'eventDate', 'creatorId', 'createdAt', 'updatedAt'].sort());
  assert.deepEqual(await (await request(`/api/events/${id(2)}`)).json(), { error: 'Event not found.' });
  assert.equal((await request(`/api/events/${id(2)}`)).status, 404);
  const callCount = db.calls.length;
  for (const value of ['invalid', '123', 'g'.repeat(24), '%7B%22%24ne%22:null%7D']) {
    const invalid = await request(`/api/events/${value}`);
    assert.equal(invalid.status, 400); assert.deepEqual(await invalid.json(), { error: 'Invalid event identifier.' });
  }
  assert.equal(db.calls.length, callCount);
});

test('missing configuration and driver/cursor failures return only sanitized 503 responses', async t => {
  const secret = 'mongodb://user:DO-NOT-EXPOSE@private.invalid/secret';
  const failing = { find() { throw Error(secret); }, async findOne() { throw Object.assign(Error(secret), { status: 400 }); } };
  for (const repository of [undefined, createEventRepository(failing), {
    async listUpcomingEvents() { throw Error(secret); }, async findEventById() { throw Error(secret); },
  }, createEventRepository({ find() { return { sort() { return this; }, skip() { return this; }, limit() { return this; }, async toArray() { throw Error(secret); } }; }, findOne: failing.findOne })]) {
    const request = await serve(t, repository);
    for (const path of ['/api/events', '/api/events/upcoming', `/api/events/${id(1)}`]) {
      const response = await request(path); assert.equal(response.status, 503);
      assert.deepEqual(await response.json(), { error: 'Event data is temporarily unavailable.' });
    }
    assert.equal((await request('/api/events/invalid')).status, 400);
    assert.equal((await request('/api/events?page=0')).status, 400);
    assert.equal((await request('/api/health')).status, 200);
  }
});

test('public event routes preserve CORS, security headers, health, authz and unsupported methods', async t => {
  const db = collection(); const request = await serve(t, createEventRepository(db), {
    middleware(req, _res, next) { req.auth = { subject: 'verified-user', scopes: ['noblenest:events'] }; next(); },
  });
  assert.deepEqual(await (await request('/api/authz/me')).json(), { subject: 'verified-user', scopes: ['noblenest:events'] });
  assert.deepEqual(await (await request('/api/health')).json(), { status: 'ok' });
  const allowed = await request('/api/events', { headers: { Origin: config.origins[0] } });
  assert.equal(allowed.headers.get('access-control-allow-origin'), config.origins[0]);
  assert.equal(allowed.headers.get('x-content-type-options'), 'nosniff'); assert.equal(allowed.headers.get('x-powered-by'), null);
  const denied = await request('/api/events', { headers: { Origin: 'https://unapproved.invalid' } });
  assert.equal(denied.status, 403); assert.equal(denied.headers.get('access-control-allow-origin'), null);
  const preflight = await request('/api/events', { method: 'OPTIONS', headers: { Origin: config.origins[0], 'Access-Control-Request-Method': 'GET' } });
  assert.equal(preflight.status, 204); assert.equal(preflight.headers.get('access-control-allow-methods'), 'GET,HEAD,OPTIONS,POST,PATCH,DELETE');
  const before = db.calls.length;
  for (const path of ['/api/events', '/api/events/upcoming', `/api/events/${id(1)}`, `/api/events/${id(1)}/join`]) {
    assert.equal((await request(path, { method: 'PUT' })).status, 404, `PUT ${path}`);
  }
  for (const method of ['POST', 'PATCH', 'DELETE']) assert.equal((await request(`/api/events/${id(1)}/join`, { method })).status, 404);
  assert.equal(db.calls.length, before);
  assert.equal((await request('/api/events', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{' })).status, 400);
  assert.equal((await request('/api/events', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: 'a'.repeat(17000) }) })).status, 413);
  const noAuth = await serve(t, undefined);
  assert.equal((await noAuth('/api/authz/me')).status, 503);
});
