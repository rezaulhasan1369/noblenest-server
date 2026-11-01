import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BSON, ObjectId } from 'mongodb';
import { generateKeyPair, SignJWT } from 'jose';
import { createApp } from '../src/app.js';
import { bearerAuthorization, createTokenVerifier } from '../src/authorization.js';
import { createEventRepository } from '../src/event-repository.js';

const jwtConfig = { issuer: 'https://client.example.invalid', audience: 'https://api.example.invalid' };
const now = new Date('2030-01-01T00:00:00.000Z');
const id = number => number.toString(16).padStart(24, '0');
function fixture(number, creatorId = 'owner', date = '2035-01-01T09:00:00.000Z') {
  return { _id: new ObjectId(id(number)), creatorId, title: `Isolated fixture ${number}`,
    description: 'In-memory test only.', eventType: 'Cleanup', thumbnailUrl: 'https://example.invalid/image.webp',
    thumbnailAlt: 'Fixture activity', location: 'Test location', eventDate: new Date(date),
    createdAt: now, updatedAt: now, internalField: 'PRIVATE metadata' };
}
const clone = document => BSON.deserialize(BSON.serialize(document));
// This collection has no mutation or index methods. It never constructs a client.
class Collection {
  constructor(documents) { this.documents = documents; }
  calls = [];
  find(filter, options) {
    const call = { filter, options }; this.calls.push(call);
    const documents = this.documents;
    return {
      sort(value) { call.sort = value; return this; },
      skip(value) { call.skip = value; return this; },
      limit(value) { call.limit = value; return this; },
      async toArray() {
        assert.deepEqual(call.sort, { eventDate: 1, _id: 1 });
        return documents.filter(document => filter.creatorId === undefined ? document.eventDate > filter.eventDate.$gt : document.creatorId === filter.creatorId)
          .sort((a, b) => a.eventDate - b.eventDate || a._id.toHexString().localeCompare(b._id.toHexString()))
          .slice(call.skip, call.skip + call.limit).map(clone);
      },
    };
  }
  async findOne(filter, options) {
    this.calls.push({ filter, options, method: 'findOne' });
    return this.documents.find(document => document._id.equals(filter._id)) ?? null;
  }
}
async function setup(t, { documents = [], repository: suppliedRepository, overrideRepository = false, noAuth = false } = {}) {
  const key = await generateKeyPair('EdDSA'), forged = await generateKeyPair('EdDSA');
  const sessions = new Map([['session-owner', 'owner'], ['session-other', 'other']]);
  const verify = createTokenVerifier(jwtConfig, key.publicKey, async (sid, sub) => sessions.get(sid) === sub);
  const collection = new Collection(documents);
  const repository = overrideRepository ? suppliedRepository : createEventRepository(collection, { now: () => now });
  const authorization = noAuth ? undefined : { middleware: bearerAuthorization(verify) };
  const server = createApp({ origins: [jwtConfig.issuer] }, authorization, repository).listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  async function mint(patch = {}, signingKey = key.privateKey) {
    const seconds = Math.floor(Date.now() / 1000);
    return new SignJWT({ iss: jwtConfig.issuer, aud: jwtConfig.audience, sub: 'owner', sid: 'session-owner', scope: 'noblenest:events',
      iat: seconds, exp: seconds + 300, ...patch }).setProtectedHeader({ alg: 'EdDSA' }).sign(signingKey);
  }
  const token = await mint();
  const request = (path = '/api/events/mine', { auth = token, headers = {}, method = 'GET' } = {}) => fetch(`http://127.0.0.1:${server.address().port}${path}`, {
    method, headers: { ...(auth ? { Authorization: `Bearer ${auth}` } : {}), ...headers },
  });
  return { request, mint, forged, sessions, collection };
}

test('mine uses verified database creator filter, established DTO, stable date/ID ordering and includes past owned events', async t => {
  const { request, collection } = await setup(t, { documents: [fixture(3), fixture(2, 'other'), fixture(4, 'owner', '2020-01-01T00:00:00.000Z'), fixture(1)] });
  const response = await request(); assert.equal(response.status, 200); assert.equal(response.headers.get('cache-control'), 'no-store');
  const data = await response.json();
  assert.deepEqual(data.pagination, { page: 1, pageSize: 12 });
  assert.deepEqual(data.events.map(event => event.id), [id(4), id(1), id(3)]);
  assert(data.events.every(event => event.creatorId === 'owner'));
  assert.equal(JSON.stringify(data).includes('PRIVATE'), false);
  assert.deepEqual(Object.keys(data.events[0]).sort(), ['id', 'title', 'description', 'eventType', 'thumbnailUrl', 'thumbnailAlt', 'location', 'eventDate', 'creatorId', 'createdAt', 'updatedAt'].sort());
  const call = collection.calls[0]; assert.deepEqual(call.filter, { creatorId: 'owner' });
  assert.deepEqual(call.sort, { eventDate: 1, _id: 1 }); assert.equal(call.skip, 0); assert.equal(call.limit, 12);
  assert.equal(call.options.projection.creatorId, 1); assert.equal(call.options.projection.internalField, undefined);
});

test('empty owned lists and out-of-data pages return an empty array and pagination', async t => {
  const { request } = await setup(t, { documents: [fixture(1, 'other')] });
  for (const [query, pagination] of [['', { page: 1, pageSize: 12 }], ['?page=1000&pageSize=50', { page: 1000, pageSize: 50 }]]) {
    const response = await request('/api/events/mine' + query); assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { events: [], pagination });
  }
});

test('missing, malformed, forged, expired, wrong-claim and missing-scope JWTs never reach the collection', async t => {
  const { request, mint, forged, collection } = await setup(t, { documents: [fixture(1)] });
  const tokens = [null, 'malformed', await mint({}, forged.privateKey)];
  for (const claims of [{ exp: 1 }, { iat: 1 }, { scope: 'other' }, { scope: undefined }, { sid: 'revoked' }, { sub: 'other' }, { iss: 'https://attacker.invalid' }, { aud: 'wrong' }, { sid: null }]) tokens.push(await mint(claims));
  for (const auth of tokens) {
    const response = await request('/api/events/mine?creatorId=owner', { auth, headers: { Cookie: 'noblenest.session_token=browser-identity', 'x-user-id': 'owner' } });
    assert.equal(response.status, 401); assert.deepEqual(await response.json(), { error: 'Authentication required' });
    assert.equal(response.headers.get('cache-control'), 'no-store');
  }
  assert.equal((await request('/api/events/mine', { headers: { Authorization: 'Basic owner' } })).status, 401);
  assert.equal(collection.calls.length, 0);
});

test('active session is checked for each listing; revoked sessions cannot reuse a previously accepted JWT', async t => {
  const { request, sessions, collection } = await setup(t, { documents: [fixture(1)] });
  assert.equal((await request()).status, 200); sessions.delete('session-owner');
  const response = await request(); assert.equal(response.status, 401);
  assert.deepEqual(await response.json(), { error: 'Authentication required' }); assert.equal(collection.calls.length, 1);
});

test('creator spoofing is rejected in query and ignored in identity headers/cookies; different creators remain isolated', async t => {
  const { request, mint, collection } = await setup(t, { documents: [fixture(1), fixture(2, 'other')] });
  for (const query of ['creatorId=other', 'userId=other', 'email=other@example.invalid', 'subject=other', 'auth=other', 'creatorId[$ne]=owner']) {
    const response = await request('/api/events/mine?' + query); assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), { error: 'Invalid event query.' });
  }
  assert.equal(collection.calls.length, 0);
  const owner = await (await request('/api/events/mine', { headers: { 'x-user-id': 'other', 'x-creator-id': 'other', Cookie: 'noblenest.session_token=other', email: 'other@example.invalid' } })).json();
  const other = await (await request('/api/events/mine', { auth: await mint({ sub: 'other', sid: 'session-other' }) })).json();
  assert.deepEqual(owner.events.map(event => event.id), [id(1)]); assert.deepEqual(other.events.map(event => event.id), [id(2)]);
  assert.deepEqual(collection.calls.map(call => call.filter), [{ creatorId: 'owner' }, { creatorId: 'other' }]);
});

test('default, partial and boundary pagination apply approved limits at the MongoDB cursor', async t => {
  const { request, collection } = await setup(t, { documents: Array.from({ length: 30 }, (_, index) => fixture(index + 1)) });
  for (const [query, page, pageSize] of [['', 1, 12], ['?page=2', 2, 12], ['?pageSize=1', 1, 1], ['?page=2&pageSize=1', 2, 1], ['?page=1000&pageSize=50', 1000, 50], ['?pageSize=50&page=1', 1, 50]]) {
    const response = await request('/api/events/mine' + query); assert.equal(response.status, 200);
    const data = await response.json(); assert.deepEqual(data.pagination, { page, pageSize });
    const call = collection.calls.at(-1); assert.equal(call.skip, (page - 1) * pageSize); assert.equal(call.limit, pageSize);
    assert(data.events.length <= pageSize);
    if (page === 2 && pageSize === 12) assert.deepEqual(data.events.map(event => event.id), Array.from({ length: 12 }, (_, index) => id(index + 13)));
  }
});

test('duplicate, unknown, malformed, oversized and operator-style query parameters fail before repository access', async t => {
  const { request, collection } = await setup(t);
  const queries = ['page=0', 'page=1001', 'page=-1', 'page=1.2', 'page=1e2', 'page=01', 'page=', 'page=%20', 'page=NaN', 'page=999999999999999999999', 'page=1&page=2', 'page=1&%70age=1',
    'pageSize=0', 'pageSize=51', 'pageSize=-1', 'pageSize=1.2', 'pageSize=1e1', 'pageSize=012', 'pageSize=', 'pageSize=12&pageSize=12', 'pageSize=12&%70ageSize=12',
    'page[]=1', 'page[$gt]=1', 'pageSize[$ne]=1', 'sort=eventDate', 'offset=0', 'limit=50', '$where=x', '__proto__=x', 'constructor=x', 'page=%FF', 'page=%ZZ', 'pageSize=12?x=1'];
  for (const query of queries) {
    const response = await request('/api/events/mine?' + query); assert.equal(response.status, 400, query);
    assert.deepEqual(await response.json(), { error: 'Invalid event query.' }); assert.equal(response.headers.get('cache-control'), 'no-store');
  }
  assert.equal(collection.calls.length, 0);
});

test('database/async cursor/unexpected errors and absent storage return fixed safe 503s without raw details', async t => {
  const fail = () => { throw Object.assign(Error('mongodb://fixture:PRIVATE@internal.example.invalid/secret stack'), { status: 400, code: 'INVALID_PAGINATION' }); };
  const failingCollection = { find: fail };
  const failingCursor = { find() { return { sort() { return this; }, skip() { return this; }, limit() { return this; }, async toArray() { fail(); } }; } };
  for (const repository of [undefined, { listEventsByCreator: fail }, createEventRepository(failingCollection), createEventRepository(failingCursor)]) {
    const { request } = await setup(t, { repository, overrideRepository: true });
    const response = await request(); assert.equal(response.status, 503); assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.deepEqual(await response.json(), { error: 'Event data is temporarily unavailable.' });
  }
});

test('missing authentication configuration preserves 503 and mine resolves before the dynamic public ID route', async t => {
  const disabled = await setup(t, { noAuth: true });
  const response = await disabled.request(); assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { error: 'Authentication is not configured' });
  assert.equal(response.headers.get('cache-control'), 'no-store'); assert.equal(disabled.collection.calls.length, 0);
  let calls = 0;
  const { request } = await setup(t, { overrideRepository: true, repository: {
    async listEventsByCreator(auth, options) {
      calls++; assert.equal(auth.subject, 'owner'); assert.equal(auth.sessionId, 'session-owner');
      assert.deepEqual(options, { page: 1, pageSize: 12 }); return [];
    },
    findEventById() { assert.fail('mine must never be interpreted as an event identifier'); },
  } });
  const mine = await request(); assert.equal(mine.status, 200); assert.equal(calls, 1);
});

test('mine preserves CORS/security and does not turn public GET endpoints into authenticated routes', async t => {
  const { request } = await setup(t, { documents: [fixture(1)] });
  for (const path of ['/api/events', '/api/events/upcoming', `/api/events/${id(1)}`, '/api/health']) assert.equal((await request(path, { auth: null })).status, 200, path);
  assert.equal((await request('/api/events/invalid', { auth: null })).status, 400);
  assert.deepEqual(await (await request('/api/authz/me')).json(), { subject: 'owner', scopes: ['noblenest:events'] });
  const allowed = await request('/api/events/mine', { headers: { Origin: jwtConfig.issuer } });
  assert.equal(allowed.headers.get('access-control-allow-origin'), jwtConfig.issuer);
  assert.equal(allowed.headers.get('access-control-allow-credentials'), null); assert.equal(allowed.headers.get('x-powered-by'), null);
  assert.equal(allowed.headers.get('x-content-type-options'), 'nosniff');
  const denied = await request('/api/events/mine', { headers: { Origin: 'https://attacker.invalid' } }); assert.equal(denied.status, 403);
  const preflight = await request('/api/events/mine', { auth: null, method: 'OPTIONS', headers: { Origin: jwtConfig.issuer, 'Access-Control-Request-Method': 'GET', 'Access-Control-Request-Headers': 'authorization' } });
  assert.equal(preflight.status, 204); assert.equal(preflight.headers.get('access-control-allow-methods'), 'GET,HEAD,OPTIONS,POST,PATCH,DELETE');
});
