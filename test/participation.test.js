import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { request as httpRequest } from 'node:http';
import { BSON, ObjectId } from 'mongodb';
import { generateKeyPair, SignJWT } from 'jose';
import { createApp } from '../src/app.js';
import { bearerAuthorization, createTokenVerifier } from '../src/authorization.js';
import { createEventRepository } from '../src/event-repository.js';
import { EventDataError } from '../src/event-model.js';
import { createParticipationRepository, PARTICIPATION_COLLECTION_NAME, PARTICIPATION_INDEXES } from '../src/participation-repository.js';

const clock = new Date('2030-01-01T00:00:00.000Z');
const jwtConfig = { issuer: 'https://client.example.invalid', audience: 'https://api.example.invalid' };
const id = number => number.toString(16).padStart(24, '0');
const clone = value => BSON.deserialize(BSON.serialize(value));
const auth = subject => ({ subject, sessionId: `session-${subject}`, scopes: ['noblenest:events'] });
function event(number, creatorId = 'owner', date = '2035-01-01T09:00:00.000Z') {
  return { _id: new ObjectId(id(number)), creatorId, title: `Isolated event ${number}`, description: 'In-memory fixture only.', eventType: 'Cleanup',
    thumbnailUrl: 'https://example.invalid/image.webp', thumbnailAlt: 'Fixture image', location: 'Fixture location', eventDate: new Date(date), createdAt: clock, updatedAt: clock, private: 'PRIVATE' };
}
function doubles(documents = [event(1)]) {
  const calls = [], records = [];
  const events = { documents, async findOne(filter, options) { calls.push({ method: 'event.findOne', filter, options }); return documents.find(row => row._id.equals(filter._id)) ?? null; } };
  const participants = {
    indexes: clone({ values: PARTICIPATION_INDEXES }).values,
    listIndexes() { calls.push({ method: 'listIndexes' }); return { toArray: async () => participants.indexes }; },
    async insertOne(document) {
      calls.push({ method: 'insertOne', document: clone(document) }); await Promise.resolve();
      // Model the database's atomic unique-pair constraint, not a route-level
      // read-then-insert check. No real collection/index is created.
      if (records.some(row => row.eventId.equals(document.eventId) && row.userId === document.userId)) throw Object.assign(Error('PRIVATE duplicate key'), { code: 11000 });
      records.push(clone(document)); return { acknowledged: true };
    },
    async findOne(filter, options) { calls.push({ method: 'participant.findOne', filter, options }); return records.find(row => row.eventId.equals(filter.eventId) && row.userId === filter.userId) ?? null; },
    aggregate(pipeline, options) {
      calls.push({ method: 'aggregate', pipeline, options });
      const [match, lookup, unwind, sort, skip, limit, project] = pipeline;
      assert.equal(pipeline.length, 7); assert.deepEqual(Object.keys(match.$match), ['userId']);
      assert.equal(lookup.$lookup.from, 'nn_events'); assert.equal(lookup.$lookup.localField, 'eventId'); assert.equal(lookup.$lookup.foreignField, '_id'); assert.equal(lookup.$lookup.as, 'event');
      assert.equal(lookup.$lookup.pipeline[0].$project.private, undefined);
      assert.equal(unwind.$unwind, '$event'); assert.deepEqual(sort.$sort, { 'event.eventDate': 1, 'event._id': 1, _id: 1 });
      assert.deepEqual(project.$project, { _id: 1, joinedAt: 1, event: 1 });
      assert.deepEqual(options, { maxTimeMS: 5000, allowDiskUse: false });
      return { async toArray() {
        return records.filter(row => row.userId === match.$match.userId)
          .flatMap(row => { const found = documents.find(document => document._id.equals(row.eventId)); return found ? [{ ...clone(row), event: clone(found) }] : []; })
          .sort((a, b) => a.event.eventDate - b.event.eventDate || a.event._id.toHexString().localeCompare(b.event._id.toHexString()) || a._id.toHexString().localeCompare(b._id.toHexString()))
          .slice(skip.$skip, skip.$skip + limit.$limit);
      } };
    },
  };
  return { events, participants, calls, records, repository: createParticipationRepository(participants, events, { now: () => clock }) };
}
async function setup(t, options = {}) {
  const store = doubles(options.documents);
  const repository = options.overrideRepository ? options.repository : store.repository;
  const key = await generateKeyPair('EdDSA'), forged = await generateKeyPair('EdDSA');
  const sessions = new Map([['session-owner', 'owner'], ['session-other', 'other']]);
  const verifier = createTokenVerifier(jwtConfig, key.publicKey, async (sid, sub) => sessions.get(sid) === sub);
  const authorization = options.noAuth ? undefined : { middleware: bearerAuthorization(verifier) };
  const server = createApp({ origins: [jwtConfig.issuer] }, authorization, createEventRepository(store.events), repository).listen(0, '127.0.0.1');
  await once(server, 'listening'); t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  async function mint(patch = {}, signingKey = key.privateKey) {
    const seconds = Math.floor(Date.now() / 1000);
    return new SignJWT({ iss: jwtConfig.issuer, aud: jwtConfig.audience, sub: 'owner', sid: 'session-owner', scope: 'noblenest:events', iat: seconds, exp: seconds + 300, ...patch })
      .setProtectedHeader({ alg: 'EdDSA' }).sign(signingKey);
  }
  const token = await mint();
  const request = (method = 'POST', path = `/api/events/${id(1)}/join`, { auth: jwt = token, headers = {}, body, raw } = {}) => fetch(base + path, {
    method, headers: { ...(jwt ? { Authorization: `Bearer ${jwt}` } : {}), ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...headers },
    body: raw ?? (body !== undefined ? JSON.stringify(body) : undefined),
  });
  return { ...store, request, mint, token, forged, sessions, base };
}

test('authenticated creator can join own event; IDs/time are server-generated BSON and DTO contains no participant identity', async t => {
  const { request, records, calls } = await setup(t);
  const response = await request('POST', undefined, { headers: { 'x-user-id': 'other', Cookie: 'noblenest.session_token=other' } });
  assert.equal(response.status, 201); assert.equal(response.headers.get('cache-control'), 'no-store');
  const { participation } = await response.json();
  assert.match(participation.id, /^[a-f0-9]{24}$/); assert.equal(participation.eventId, id(1)); assert.equal(participation.joinedAt, clock.toISOString());
  assert.deepEqual(Object.keys(participation).sort(), ['id', 'eventId', 'joinedAt'].sort());
  assert(records[0]._id instanceof ObjectId); assert(records[0].eventId instanceof ObjectId); assert(records[0].joinedAt instanceof Date); assert.equal(records[0].userId, 'owner');
  const probe = calls.find(call => call.method === 'participant.findOne');
  assert.equal(probe.options.hint, 'participants_event_user_unique'); assert.deepEqual(probe.filter, { eventId: new ObjectId(id(1)), userId: 'owner' });
});

test('join and joined reject absent/forged/expired/revoked/wrong-claim/missing-scope tokens without database calls', async t => {
  const { request, mint, forged, calls } = await setup(t);
  const tokens = [null, 'malformed', await mint({}, forged.privateKey)];
  for (const patch of [{ exp: 1 }, { iat: 1 }, { sid: 'revoked' }, { scope: 'other' }, { scope: undefined }, { iss: 'https://attacker.invalid' }, { aud: 'wrong' }, { sub: 'other' }]) tokens.push(await mint(patch));
  for (const jwt of tokens) for (const [method, path] of [['POST', `/api/events/${id(1)}/join`], ['GET', '/api/events/joined']]) {
    const response = await request(method, path, { auth: jwt, headers: { 'x-user-id': 'owner', Cookie: 'noblenest.session_token=owner' } });
    assert.equal(response.status, 401); assert.deepEqual(await response.json(), { error: 'Authentication required' }); assert.equal(response.headers.get('cache-control'), 'no-store');
  }
  assert.equal(calls.length, 0);
});

test('invalid IDs are 400, nonexistent events are 404 and neither creates a participation', async t => {
  const { request, records, calls } = await setup(t);
  for (const value of ['invalid', '123', 'x'.repeat(24)]) {
    const response = await request('POST', `/api/events/${value}/join`); assert.equal(response.status, 400); assert.deepEqual(await response.json(), { error: 'Invalid event identifier.' });
  }
  assert.equal(calls.length, 0);
  const missing = await request('POST', `/api/events/${id(99)}/join`); assert.equal(missing.status, 404); assert.deepEqual(await missing.json(), { error: 'Event not found.' });
  assert.equal(records.length, 0); assert.equal(calls.some(call => call.method === 'listIndexes'), false);
});

test('sequential and concurrent joins are idempotent via duplicate-key recovery and the confirmed unique constraint', async t => {
  const { request, records, repository } = await setup(t);
  const responses = await Promise.all(Array.from({ length: 8 }, () => request()));
  assert.equal(responses.filter(response => response.status === 201).length, 1); assert.equal(responses.filter(response => response.status === 200).length, 7);
  const data = await Promise.all(responses.map(response => response.json())); assert.equal(new Set(data.map(row => row.participation.id)).size, 1); assert.equal(records.length, 1);
  const repeat = await request(); assert.equal(repeat.status, 200); assert.deepEqual(await repeat.json(), data[0]);
  const other = await Promise.all(Array.from({ length: 12 }, () => repository.joinEvent(auth('other'), id(1))));
  assert.equal(other.filter(row => row.created).length, 1); assert.equal(records.length, 2);
});

test('joins fail closed without the full unique pair index, including partial/sparse/non-unique metadata and failed inspection', async () => {
  const examples = [[], [{ ...PARTICIPATION_INDEXES[0], unique: false }], [{ ...PARTICIPATION_INDEXES[0], sparse: true }],
    [{ ...PARTICIPATION_INDEXES[0], partialFilterExpression: { userId: 'owner' } }], [{ ...PARTICIPATION_INDEXES[0], key: { eventId: 1, userId: 1, role: 1 } }],
    [{ ...PARTICIPATION_INDEXES[0], collation: { locale: 'en', strength: 2 } }], [{ ...PARTICIPATION_INDEXES[0], prepareUnique: true }],
    [{ ...PARTICIPATION_INDEXES[0], hidden: true }], [{ ...PARTICIPATION_INDEXES[0], buildUUID: 'building' }]];
  for (const indexes of examples) {
    const store = doubles(); store.participants.indexes = indexes;
    await assert.rejects(store.repository.joinEvent(auth('owner'), id(1)), error => error instanceof EventDataError && error.statusCode === 503);
    assert.equal(store.records.length, 0); assert.equal(store.calls.some(call => call.method === 'insertOne'), false);
  }
  const store = doubles(); store.participants.listIndexes = () => { throw Object.assign(Error('PRIVATE index permissions'), { code: 26 }); };
  await assert.rejects(store.repository.joinEvent(auth('owner'), id(1)), { message: 'Participation data is temporarily unavailable.' }); assert.equal(store.records.length, 0);
  const uncached = doubles(); await uncached.repository.joinEvent(auth('owner'), id(1)); uncached.participants.indexes = [];
  await assert.rejects(uncached.repository.joinEvent(auth('other'), id(1)), { message: 'Participation data is temporarily unavailable.' }); assert.equal(uncached.records.length, 1);
  const building = doubles(); building.participants.findOne = async (_filter, options) => {
    assert.equal(options.hint, 'participants_event_user_unique'); throw Error('PRIVATE index is not ready');
  };
  await assert.rejects(building.repository.joinEvent(auth('owner'), id(1)), { message: 'Participation data is temporarily unavailable.' }); assert.equal(building.calls.some(call => call.method === 'insertOne'), false);
});

test('11000 only recovers the exact verified pair; unrelated duplicate and unacknowledged writes are sanitized', async () => {
  for (const insertOne of [async () => { throw Object.assign(Error('PRIVATE _id collision'), { code: 11000 }); }, async () => ({ acknowledged: false })]) {
    const store = doubles(); store.participants.insertOne = insertOne;
    await assert.rejects(store.repository.joinEvent(auth('owner'), id(1)), { message: 'Participation data is temporarily unavailable.' });
    assert.equal(store.records.length, 0);
  }
});

test('joined results filter verified participant inside MongoDB, resolve others events, sort date/ID and omit deleted references before paging', async t => {
  const store = await setup(t, { documents: [event(3, 'other'), event(2, 'other'), event(1, 'owner', '2020-01-01T00:00:00.000Z')] });
  for (const number of [3, 2, 1]) await store.repository.joinEvent(auth('owner'), id(number));
  await store.repository.joinEvent(auth('other'), id(3));
  store.records.push({ _id: new ObjectId(), eventId: new ObjectId(id(99)), userId: 'owner', joinedAt: clock });
  const response = await store.request('GET', '/api/events/joined?pageSize=2'); assert.equal(response.status, 200);
  const data = await response.json(); assert.deepEqual(data.pagination, { page: 1, pageSize: 2 });
  assert.deepEqual(data.events.map(row => row.event.id), [id(1), id(2)]); assert(data.events.every(row => row.participationId && row.joinedAt));
  assert.equal(JSON.stringify(data).includes('PRIVATE'), false); assert.equal(data.events[0].userId, undefined);
  const call = store.calls.filter(call => call.method === 'aggregate').at(-1); assert.deepEqual(call.pipeline[0], { $match: { userId: 'owner' } });
  const page2 = await (await store.request('GET', '/api/events/joined?page=2&pageSize=2')).json(); assert.deepEqual(page2.events.map(row => row.event.id), [id(3)]);
  const other = await (await store.request('GET', '/api/events/joined', { auth: await store.mint({ sub: 'other', sid: 'session-other' }) })).json(); assert.deepEqual(other.events.map(row => row.event.id), [id(3)]);
  store.events.documents.splice(store.events.documents.findIndex(row => row._id.equals(id(2))), 1);
  const afterDelete = await (await store.request('GET', '/api/events/joined?pageSize=2')).json(); assert.deepEqual(afterDelete.events.map(row => row.event.id), [id(1), id(3)]);
  assert.equal(store.records.length, 5, 'orphan rows are not deleted by reads');
});

test('joined defaults, empty lists and maximum pagination are bounded without a public fallback', async t => {
  const { request, calls } = await setup(t);
  assert.deepEqual(await (await request('GET', '/api/events/joined')).json(), { events: [], pagination: { page: 1, pageSize: 12 } });
  const response = await request('GET', '/api/events/joined?page=1000&pageSize=50'); assert.equal(response.status, 200);
  const call = calls.filter(row => row.method === 'aggregate').at(-1); assert.deepEqual(call.pipeline[4], { $skip: 49950 }); assert.deepEqual(call.pipeline[5], { $limit: 50 });
});

test('unexpected identity/query/body fields and unsupported content types cannot reach participation storage', async t => {
  const { request, calls, base, token } = await setup(t);
  for (const query of ['userId=other', 'creatorId=other', 'role=admin', 'page=0', 'pageSize=51', 'page=1&page=2', 'pageSize=12&%70ageSize=12', 'page[$gt]=1', 'sort=x', 'page=1e2', 'page=01']) {
    const response = await request('GET', '/api/events/joined?' + query); assert.equal(response.status, 400); assert.deepEqual(await response.json(), { error: 'Invalid event query.' });
  }
  for (const query of ['userId=other', 'page=1', 'creatorId=owner']) assert.equal((await request('POST', `/api/events/${id(1)}/join?${query}`)).status, 400);
  for (const body of [{}, { userId: 'other' }, { creatorId: 'other', role: 'admin' }]) assert.equal((await request('POST', undefined, { body })).status, 400);
  for (const type of ['text/plain', 'application/x-www-form-urlencoded', 'application/vnd.api+json']) assert.equal((await request('POST', undefined, { raw: 'userId=other', headers: { 'Content-Type': type } })).status, 415);
  assert.equal((await request('POST', undefined, { raw: '{', headers: { 'Content-Type': 'application/json' } })).status, 400);
  assert.equal((await request('POST', undefined, { body: { userId: 'x'.repeat(17000) } })).status, 413);
  const rawGet = await new Promise((resolve, reject) => {
    const body = JSON.stringify({ userId: 'other' });
    const req = httpRequest(base + '/api/events/joined', { method: 'GET', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } }, res => { res.resume(); res.on('end', () => resolve(res.statusCode)); });
    req.on('error', reject); req.end(body);
  });
  assert.equal(rawGet, 400); assert.equal(calls.length, 0);
});

test('driver/metadata/cursor/DTO errors and absent stores return safe generic responses', async t => {
  const fail = () => { throw Object.assign(Error('PRIVATE driver hostname credential stack'), { status: 404 }); };
  const missingIndex = await setup(t); missingIndex.participants.indexes = [];
  const blocked = await missingIndex.request(); assert.equal(blocked.status, 503); assert.deepEqual(await blocked.json(), { error: 'Participation data is temporarily unavailable.' }); assert.equal(missingIndex.records.length, 0);
  for (const repository of [undefined, { joinEvent: fail, listJoinedEvents: fail }]) {
    const { request } = await setup(t, { overrideRepository: true, repository });
    for (const [method, path] of [['POST', `/api/events/${id(1)}/join`], ['GET', '/api/events/joined']]) {
      const response = await request(method, path); assert.equal(response.status, 503); assert.equal(response.headers.get('cache-control'), 'no-store');
      assert.deepEqual(await response.json(), { error: 'Participation data is temporarily unavailable.' });
    }
  }
  for (const method of ['listIndexes', 'insertOne', 'aggregate']) {
    const store = doubles(); store.participants[method] = fail;
    await assert.rejects(method === 'aggregate' ? store.repository.listJoinedEvents(auth('owner')) : store.repository.joinEvent(auth('owner'), id(1)), { message: 'Participation data is temporarily unavailable.' });
  }
  const store = doubles(); store.participants.aggregate = () => ({ toArray: async () => [{ _id: new ObjectId(), joinedAt: 'invalid', event: event(1) }] });
  await assert.rejects(store.repository.listJoinedEvents(auth('owner')), { message: 'Participation data is temporarily unavailable.' });
});

test('missing auth config is 503, session revocation is rechecked, joined precedes :id and public reads stay public', async t => {
  const disabled = await setup(t, { noAuth: true });
  for (const [method, path] of [['POST', `/api/events/${id(1)}/join`], ['GET', '/api/events/joined']]) {
    const response = await disabled.request(method, path); assert.equal(response.status, 503); assert.deepEqual(await response.json(), { error: 'Authentication is not configured' });
  }
  const store = await setup(t); assert.equal((await store.request()).status, 201); store.sessions.delete('session-owner');
  assert.equal((await store.request()).status, 401); assert.equal((await store.request('GET', '/api/events/joined')).status, 401);
  for (const path of ['/api/health', `/api/events/${id(1)}`]) assert.equal((await store.request('GET', path, { auth: null })).status, 200);
  const empty = await setup(t); const joined = await empty.request('GET', '/api/events/joined'); assert.equal(joined.status, 200);
  assert.equal(empty.calls.some(call => call.method === 'event.findOne'), false, 'joined must not enter dynamic event lookup');
  const allowed = await empty.request('GET', '/api/events/joined', { headers: { Origin: jwtConfig.issuer } }); assert.equal(allowed.headers.get('access-control-allow-origin'), jwtConfig.issuer);
  assert.equal(allowed.headers.get('x-content-type-options'), 'nosniff'); assert.equal(allowed.headers.get('x-powered-by'), null);
  assert.equal((await empty.request('POST', undefined, { headers: { Origin: 'https://attacker.invalid' } })).status, 403);
});

test('construction and offline index planning never mutate/connect/create indexes; plan refuses apply flags', async () => {
  const store = doubles(); assert.equal(store.calls.length, 0); assert.equal(PARTICIPATION_COLLECTION_NAME, 'nn_event_participants');
  for (const input of [null, {}, { subject: 'owner' }]) await assert.rejects(store.repository.joinEvent(input, id(1)), error => error.code === 'AUTH_REQUIRED');
  await assert.rejects(store.repository.joinEvent(auth('owner'), 'invalid'), error => error.code === 'INVALID_EVENT_ID');
  await assert.rejects(store.repository.listJoinedEvents(auth('owner'), { pageSize: 51 }), error => error.code === 'INVALID_PAGINATION'); assert.equal(store.calls.length, 0);
  async function plan(args) {
    const child = spawn(process.execPath, ['scripts/participation-indexes-plan.js', ...args], { cwd: new URL('../', import.meta.url), stdio: ['ignore', 'pipe', 'pipe'] });
    let output = ''; child.stdout.on('data', chunk => { output += chunk; }); child.stderr.resume(); const [code] = await once(child, 'close'); return { output, code };
  }
  const result = await plan([]); assert.equal(result.code, 0); const data = JSON.parse(result.output);
  assert.equal(data.collection, PARTICIPATION_COLLECTION_NAME); assert.deepEqual(data.indexes, PARTICIPATION_INDEXES);
  assert.deepEqual(data.indexes[0].key, { eventId: 1, userId: 1 }); assert.equal(data.indexes[0].unique, true);
  const refused = await plan(['--apply']); assert.equal(refused.code, 1); assert.equal(refused.output, '');
});
