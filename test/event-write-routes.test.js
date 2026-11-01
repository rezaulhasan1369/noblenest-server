import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPair, SignJWT } from 'jose';
import { BSON, ObjectId } from 'mongodb';
import { createApp } from '../src/app.js';
import { bearerAuthorization, createTokenVerifier } from '../src/authorization.js';
import { createEventRepository } from '../src/event-repository.js';

const jwtConfig = { issuer: 'https://client.example.invalid', audience: 'https://api.example.invalid' };
const clock = new Date('2030-01-01T00:00:00.000Z');
const missingId = '000000000000000000000001';
const payload = () => ({ title: 'Isolated community activity', description: 'In-memory HTTP test only.',
  eventType: 'Cleanup', thumbnailUrl: 'https://example.invalid/image.webp', location: 'Test location', eventDate: '2030-02-01T09:00:00.000Z' });
const copy = value => BSON.deserialize(BSON.serialize(value));

class Collection {
  documents = [];
  calls = [];
  fail = false;
  beforeMutation;
  record(method, filter, options) {
    this.calls.push({ method, filter, options });
    if (this.fail) throw Error('mongodb://fixture:PRIVATE-ERROR@internal.example.invalid/secret');
  }
  async insertOne(document) {
    this.record('insertOne', document); this.documents.push(copy(document));
    return { acknowledged: true };
  }
  async findOne(filter, options) {
    this.record('findOne', filter, options);
    const result = this.documents.find(document => document._id.equals(filter._id));
    return result ? copy(result) : null;
  }
  find(filter, options) {
    this.record('find', filter, options); const documents = this.documents;
    let skip, limit;
    return {
      sort(value) { assert.deepEqual(value, { eventDate: 1, _id: 1 }); return this; },
      skip(value) { skip = value; return this; }, limit(value) { limit = value; return this; },
      async toArray() { return documents.filter(document => document.eventDate > filter.eventDate.$gt)
        .sort((a, b) => a.eventDate - b.eventDate || a._id.toHexString().localeCompare(b._id.toHexString()))
        .slice(skip, skip + limit).map(copy); },
    };
  }
  async findOneAndUpdate(filter, update, options) {
    this.record('findOneAndUpdate', filter, options); this.beforeMutation?.();
    const document = this.documents.find(document => document._id.equals(filter._id) && document.creatorId === filter.creatorId);
    if (!document) return null;
    Object.assign(document, copy(update.$set)); return copy(document);
  }
  async deleteOne(filter) {
    this.record('deleteOne', filter); this.beforeMutation?.();
    const index = this.documents.findIndex(document => document._id.equals(filter._id) && document.creatorId === filter.creatorId);
    if (index === -1) return { acknowledged: true, deletedCount: 0 };
    this.documents.splice(index, 1); return { acknowledged: true, deletedCount: 1 };
  }
}

async function setup(t, overrides = {}) {
  const key = await generateKeyPair('EdDSA'), forged = await generateKeyPair('EdDSA');
  const db = new Collection();
  const sessions = new Map([['session-owner', 'owner'], ['session-other', 'other']]);
  const verify = createTokenVerifier(jwtConfig, key.publicKey, async (sid, sub) => sessions.get(sid) === sub);
  const repository = Object.hasOwn(overrides, 'repository') ? overrides.repository : createEventRepository(db, { now: () => clock });
  const authorization = overrides.noAuth ? undefined : { middleware: bearerAuthorization(verify) };
  const server = createApp({ origins: [jwtConfig.issuer] }, authorization, repository).listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  async function mint(patch = {}, signingKey = key.privateKey) {
    const seconds = Math.floor(Date.now() / 1000);
    return new SignJWT({ iss: jwtConfig.issuer, aud: jwtConfig.audience, sub: 'owner', sid: 'session-owner',
      scope: 'noblenest:events', iat: seconds, exp: seconds + 300, ...patch })
      .setProtectedHeader({ alg: 'EdDSA' }).sign(signingKey);
  }
  const token = await mint();
  const request = (method, path = '/api/events', { body, headers = {}, auth = token, raw } = {}) => fetch(`http://127.0.0.1:${server.address().port}${path}`, {
    method, headers: { ...(auth ? { Authorization: `Bearer ${auth}` } : {}), ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...headers },
    body: raw !== undefined ? raw : body !== undefined ? JSON.stringify(body) : undefined,
  });
  async function create() {
    const response = await request('POST', '/api/events', { body: payload() });
    assert.equal(response.status, 201); return (await response.json()).event;
  }
  return { db, sessions, request, mint, forged, token, create };
}

test('all mutation routes reject missing, malformed, expired, forged and invalid-claim JWTs before any store access', async t => {
  const { request, mint, forged, db } = await setup(t);
  const invalid = [null, 'malformed', await mint({}, forged.privateKey)];
  for (const claims of [{ exp: 1 }, { iat: 1 }, { iss: 'https://attacker.invalid' }, { aud: 'wrong' }, { scope: 'other' }, { sid: 'revoked' }, { sub: 'other' }, { sid: null }]) invalid.push(await mint(claims));
  for (const auth of invalid) {
    for (const method of ['POST', 'PATCH', 'DELETE']) {
      const response = await request(method, method === 'POST' ? '/api/events' : `/api/events/${missingId}`, {
        auth, ...(method !== 'DELETE' ? { body: payload() } : {}), headers: { 'x-user-id': 'owner', 'x-creator-id': 'owner' },
      });
      assert.equal(response.status, 401); assert.deepEqual(await response.json(), { error: 'Authentication required' });
    }
  }
  const basic = await request('POST', '/api/events?creatorId=owner', { auth: null, body: payload(), headers: { Authorization: 'Basic owner' } });
  assert.equal(basic.status, 401); assert.equal(db.calls.length, 0);
});

test('authenticated creation derives creator from JWT, stores BSON dates and returns only approved DTO with Location', async t => {
  const { request, db } = await setup(t);
  const response = await request('POST', '/api/events', { body: payload(), headers: { 'x-user-id': 'attacker', 'x-creator-id': 'attacker', email: 'attacker@example.invalid' } });
  assert.equal(response.status, 201); assert.equal(response.headers.get('cache-control'), 'no-store');
  const { event } = await response.json();
  assert.equal(event.creatorId, 'owner'); assert.equal(response.headers.get('location'), `/api/events/${event.id}`);
  assert.match(event.id, /^[a-f0-9]{24}$/); assert.equal(event.createdAt, clock.toISOString());
  assert.equal(event.updatedAt, clock.toISOString()); assert.equal(event.thumbnailAlt, `Event image: ${event.title}`);
  assert(db.documents[0]._id instanceof ObjectId); assert(db.documents[0].eventDate instanceof Date);
  assert.equal(db.calls[0].method, 'insertOne');
  assert.deepEqual(Object.keys(event).sort(), ['id', 'title', 'description', 'eventType', 'thumbnailUrl', 'thumbnailAlt', 'location', 'eventDate', 'creatorId', 'createdAt', 'updatedAt'].sort());
});

test('POST/PATCH reject submitted identity, immutable fields, MongoDB operators and other unexpected properties', async t => {
  const { request, db, create } = await setup(t); const event = await create(); const count = db.calls.length;
  for (const field of ['creatorId', 'userId', 'email', '_id', 'id', 'createdAt', 'updatedAt', 'sessionId', 'auth', '$set', '__proto__', 'constructor']) {
    for (const method of ['POST', 'PATCH']) {
      const body = Object.fromEntries([...Object.entries(payload()), [field, 'attacker']]);
      const response = await request(method, method === 'POST' ? '/api/events' : `/api/events/${event.id}`, { body });
      assert.equal(response.status, 400, `${method} ${field}`); assert.deepEqual(await response.json(), { error: 'Invalid event data.' });
    }
  }
  assert.equal(db.calls.length, count); assert.equal(db.documents.length, 1);
});

test('POST/PATCH reuse strict validation for text, types, lengths, categories, future dates and HTTPS images', async t => {
  const { request, db, create } = await setup(t); const event = await create(); const count = db.calls.length;
  const invalid = [{ title: '' }, { title: ' '.repeat(3) }, { title: 'x'.repeat(201) }, { title: 1 }, { description: '' }, { description: 'x'.repeat(5001) },
    { eventType: 'invalid' }, { eventType: 'cleanup' }, { location: '' }, { location: 'x'.repeat(301) }, { thumbnailAlt: 'x'.repeat(301) },
    { eventDate: '2000-01-01T00:00:00.000Z' }, { eventDate: clock.toISOString() }, { eventDate: '2030-02-30T00:00:00.000Z' }, { eventDate: '2030-02-01' },
    { thumbnailUrl: 'http://example.invalid/a' }, { thumbnailUrl: 'https://user:password@example.invalid/a' }, { thumbnailUrl: 'javascript:alert(1)' }, { thumbnailUrl: 'invalid' }];
  for (const patch of invalid) for (const method of ['POST', 'PATCH']) {
    const response = await request(method, method === 'POST' ? '/api/events' : `/api/events/${event.id}`, { body: method === 'POST' ? { ...payload(), ...patch } : patch });
    assert.equal(response.status, 400, `${method} ${Object.keys(patch)[0]}`); assert.deepEqual(await response.json(), { error: 'Invalid event data.' });
  }
  for (const method of ['POST', 'PATCH']) for (const body of [{}, [], null, 'text']) {
    assert.equal((await request(method, method === 'POST' ? '/api/events' : `/api/events/${event.id}`, { body })).status, 400);
  }
  for (const field of Object.keys(payload())) {
    const body = payload(); delete body[field]; assert.equal((await request('POST', '/api/events', { body })).status, 400);
  }
  assert.equal(db.calls.length, count);
});

test('owner PATCH uses atomic owner filter and preserves immutable fields and all existing public GET routes', async t => {
  const { request, db, create } = await setup(t); const original = await create();
  const response = await request('PATCH', `/api/events/${original.id}`, { body: { title: 'Updated activity' } });
  assert.equal(response.status, 200); const { event } = await response.json();
  assert.equal(event.title, 'Updated activity'); assert.equal(event.creatorId, original.creatorId);
  assert.equal(event.createdAt, original.createdAt); assert.equal(event.id, original.id);
  const call = db.calls.at(-1); assert.equal(call.method, 'findOneAndUpdate');
  assert.deepEqual(Object.keys(call.filter).sort(), ['_id', 'creatorId']); assert(call.filter._id.equals(original.id)); assert.equal(call.filter.creatorId, 'owner');
  assert.equal(call.options.upsert, false); assert.equal(call.options.returnDocument, 'after'); assert.equal(call.options.includeResultMetadata, false);
  db.documents[0].privateField = 'NEVER-EXPOSE';
  for (const path of ['/api/events', '/api/events/upcoming', `/api/events/${original.id}`]) {
    const result = await request('GET', path, { auth: null }); assert.equal(result.status, 200);
    const text = await result.text(); assert.equal(text.includes('NEVER-EXPOSE'), false); assert.equal(text.includes('Updated activity'), true);
  }
  assert.equal((await request('GET', '/api/health', { auth: null })).status, 200);
  assert.deepEqual(await (await request('GET', '/api/authz/me')).json(), { subject: 'owner', scopes: ['noblenest:events'] });
});

test('non-owner and missing update/delete have indistinguishable 404s; valid owner delete is empty 204', async t => {
  const { request, db, mint, create } = await setup(t); const event = await create();
  const other = await mint({ sub: 'other', sid: 'session-other' });
  for (const method of ['PATCH', 'DELETE']) {
    for (const [id, auth] of [[event.id, other], [missingId, other], [missingId, undefined]]) {
      const response = await request(method, `/api/events/${id}`, { auth, ...(method === 'PATCH' ? { body: { title: 'Must not apply' } } : {}) });
      assert.equal(response.status, 404); assert.deepEqual(await response.json(), { error: 'Event not found.' });
    }
  }
  assert.equal(db.documents[0].title, event.title); assert.equal(db.documents.length, 1);
  assert.equal(db.calls.some(call => call.method === 'findOne'), false);
  const response = await request('DELETE', `/api/events/${event.id}`);
  assert.equal(response.status, 204); assert.equal(await response.text(), ''); assert.equal(db.documents.length, 0);
  const call = db.calls.at(-1); assert.equal(call.method, 'deleteOne'); assert.deepEqual(Object.keys(call.filter).sort(), ['_id', 'creatorId']);
  assert(call.filter._id.equals(event.id)); assert.equal(call.filter.creatorId, 'owner');
  assert.equal((await request('DELETE', `/api/events/${event.id}`)).status, 404);
});

test('ownership changes at mutation time defeat both HTTP PATCH and DELETE without a preceding ownership read', async t => {
  for (const method of ['PATCH', 'DELETE']) {
    const { request, db, create } = await setup(t); const event = await create();
    db.beforeMutation = () => { db.documents[0].creatorId = 'other'; };
    const response = await request(method, `/api/events/${event.id}`, method === 'PATCH' ? { body: { title: 'Must not apply' } } : {});
    assert.equal(response.status, 404); assert.deepEqual(await response.json(), { error: 'Event not found.' });
    assert.equal(db.documents.length, 1); assert.equal(db.documents[0].title, event.title);
    assert.equal(db.calls.some(call => call.method === 'findOne'), false);
  }
});

test('write IDs and all query parameters are validated before mutation', async t => {
  const { request, db } = await setup(t);
  for (const method of ['PATCH', 'DELETE']) assert.equal((await request(method, '/api/events', method === 'PATCH' ? { body: { title: 'Title' } } : {})).status, 404);
  for (const method of ['PATCH', 'DELETE']) for (const id of ['invalid', '123', 'z'.repeat(24), '%E0%A4%A']) {
    const response = await request(method, `/api/events/${id}`, method === 'PATCH' ? { body: { title: 'Title' } } : {});
    assert.equal(response.status, 400);
  }
  for (const method of ['POST', 'PATCH', 'DELETE']) for (const query of ['page=1', 'creatorId=owner', 'userId=owner', '$where=x', 'a=1&a=2', 'a[]=1']) {
    const response = await request(method, (method === 'POST' ? '/api/events' : `/api/events/${missingId}`) + `?${query}`, method !== 'DELETE' ? { body: payload() } : {});
    assert.equal(response.status, 400); assert.deepEqual(await response.json(), { error: 'Invalid event query.' });
  }
  assert.equal(db.calls.length, 0);
});

test('content types, delete bodies, malformed JSON and 16 KiB limits cannot reach mutations', async t => {
  const { request, db } = await setup(t);
  for (const method of ['POST', 'PATCH']) for (const contentType of ['text/plain', 'application/x-www-form-urlencoded', 'multipart/form-data; boundary=test', 'application/vnd.api+json', '']) {
    const response = await request(method, method === 'POST' ? '/api/events' : `/api/events/${missingId}`, { raw: JSON.stringify(payload()), headers: { 'Content-Type': contentType } });
    assert.equal(response.status, 415); assert.deepEqual(await response.json(), { error: 'Unsupported content type' });
  }
  for (const method of ['POST', 'PATCH']) {
    const path = method === 'POST' ? '/api/events' : `/api/events/${missingId}`;
    assert.equal((await request(method, path, { raw: '{', headers: { 'Content-Type': 'application/json' } })).status, 400);
    const tooLarge = await request(method, path, { body: { ...payload(), description: 'x'.repeat(17000) } });
    assert.equal(tooLarge.status, 413); assert.deepEqual(await tooLarge.json(), { error: 'Request too large' });
    assert.equal((await request(method, path, { raw: '{}', headers: { 'Content-Type': 'application/json; charset=iso-8859-1' } })).status, 415);
  }
  assert.equal((await request('DELETE', `/api/events/${missingId}`, { body: {} })).status, 400);
  assert.equal((await request('DELETE', `/api/events/${missingId}`, { raw: 'text', headers: { 'Content-Type': 'text/plain' } })).status, 415);
  assert.equal(db.calls.length, 0);
});

test('database failures, unexpected errors and missing configuration return fixed safe responses', async t => {
  const { request, db } = await setup(t); db.fail = true;
  for (const method of ['POST', 'PATCH', 'DELETE']) {
    const response = await request(method, method === 'POST' ? '/api/events' : `/api/events/${missingId}`, method === 'DELETE' ? {} : { body: payload() });
    assert.equal(response.status, 503); assert.deepEqual(await response.json(), { error: 'Event data is temporarily unavailable.' });
  }
  const failure = () => { throw Object.assign(Error('PRIVATE-ERROR token password stack'), { status: 400, code: 'INVALID_EVENT_DATA' }); };
  for (const repository of [undefined, { createEvent: failure, updateOwnedEvent: failure, deleteOwnedEvent: failure }]) {
    const isolated = await setup(t, { repository });
    for (const method of ['POST', 'PATCH', 'DELETE']) {
      const response = await isolated.request(method, method === 'POST' ? '/api/events' : `/api/events/${missingId}`, method === 'DELETE' ? {} : { body: payload() });
      assert.equal(response.status, 503); assert.deepEqual(await response.json(), { error: 'Event data is temporarily unavailable.' });
    }
  }
  const disabled = await setup(t, { noAuth: true });
  for (const method of ['POST', 'PATCH', 'DELETE']) assert.equal((await disabled.request(method, method === 'POST' ? '/api/events' : `/api/events/${missingId}`, method === 'DELETE' ? {} : { body: payload() })).status, 503);
  assert.equal(disabled.db.calls.length, 0);
});

test('revocation is checked on each write; CORS origin policy, security headers and scoped preflights remain intact', async t => {
  const { request, sessions, db } = await setup(t);
  const allowed = await request('OPTIONS', '/api/events', { auth: null, headers: { Origin: jwtConfig.issuer, 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'authorization,content-type' } });
  assert.equal(allowed.status, 204); assert.equal(allowed.headers.get('access-control-allow-origin'), jwtConfig.issuer);
  assert.equal(allowed.headers.get('access-control-allow-methods'), 'GET,HEAD,OPTIONS,POST,PATCH,DELETE');
  assert.equal(allowed.headers.get('access-control-allow-headers'), 'authorization,content-type');
  assert.equal(allowed.headers.get('access-control-allow-credentials'), null);
  const health = await request('OPTIONS', '/api/health', { headers: { Origin: jwtConfig.issuer } });
  assert.equal(health.headers.get('access-control-allow-methods'), 'GET,HEAD,OPTIONS');
  const denied = await request('POST', '/api/events', { body: payload(), headers: { Origin: 'https://attacker.invalid' } });
  assert.equal(denied.status, 403); assert.equal(denied.headers.get('access-control-allow-origin'), null); assert.equal(db.calls.length, 0);
  const valid = await request('POST', '/api/events', { body: payload(), headers: { Origin: jwtConfig.issuer } });
  assert.equal(valid.status, 201); assert.equal(valid.headers.get('x-content-type-options'), 'nosniff'); assert.equal(valid.headers.get('x-powered-by'), null);
  const event = (await valid.json()).event;
  sessions.delete('session-owner'); const before = db.calls.length;
  for (const method of ['POST', 'PATCH', 'DELETE']) {
    assert.equal((await request(method, method === 'POST' ? '/api/events' : `/api/events/${event.id}`, method === 'DELETE' ? {} : { body: payload() })).status, 401);
  }
  assert.equal(db.calls.length, before);
});
