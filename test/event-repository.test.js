import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BSON, ObjectId } from 'mongodb';
import { createEventRepository, EVENT_COLLECTION_NAME, EVENT_INDEXES } from '../src/event-repository.js';
import { EventDataError } from '../src/event-model.js';

const now = new Date('2030-01-01T00:00:00.000Z');
const identity = subject => Object.freeze({ subject, creatorEmail: `${subject}@example.invalid`, sessionId: `session-${subject}`, scopes: Object.freeze(['noblenest:events']) });
const owner = identity('test-owner'), other = identity('test-other');
const input = () => ({ title: 'Isolated repository event', description: 'In-memory test only.', eventType: 'Cleanup', thumbnailUrl: 'https://images.example.invalid/event.webp', location: 'Test location', eventDate: '2030-02-01T09:00:00.000Z' });
const clone = document => BSON.deserialize(BSON.serialize(document));
const compareValue = value => value instanceof ObjectId ? value.toHexString() : value instanceof Date ? value.getTime() : value;
const matches = (document, filter) => Object.entries(filter).every(([field, value]) => value instanceof ObjectId ? document[field].equals(value) : value && typeof value === 'object' && '$gt' in value ? document[field] > value.$gt : document[field] === value);

// An isolated collection contract double: no MongoClient, environment file,
// socket, Atlas connection or test-data insertion into an actual database.
class MemoryCollection {
  documents = [];
  calls = [];
  indexes = new Map();
  beforeMutation;
  async insertOne(document) { this.calls.push({ method: 'insertOne', document: clone(document) }); this.documents.push(clone(document)); return { acknowledged: true, insertedId: document._id }; }
  async findOne(filter, options) { this.calls.push({ method: 'findOne', filter, options }); const document = this.documents.find(document => matches(document, filter)); return document ? clone(document) : null; }
  find(filter, options) {
    const call = { method: 'find', filter, options }; this.calls.push(call);
    const collection = this;
    return {
      sort(value) { call.sort = value; return this; },
      skip(value) { call.skip = value; return this; },
      limit(value) { call.limit = value; return this; },
      async toArray() { return collection.documents.filter(document => matches(document, filter)).sort((a, b) => {
        for (const [key, direction] of Object.entries(call.sort)) { const av = compareValue(a[key]), bv = compareValue(b[key]); if (av !== bv) return av < bv ? -direction : direction; } return 0;
      }).slice(call.skip, call.skip + call.limit).map(clone); },
    };
  }
  async findOneAndUpdate(filter, update, options) {
    this.calls.push({ method: 'findOneAndUpdate', filter, update, options }); this.beforeMutation?.();
    const document = this.documents.find(document => matches(document, filter)); if (!document) return null;
    Object.assign(document, clone(update.$set)); return clone(document);
  }
  async deleteOne(filter) {
    this.calls.push({ method: 'deleteOne', filter }); this.beforeMutation?.();
    const index = this.documents.findIndex(document => matches(document, filter)); if (index < 0) return { acknowledged: true, deletedCount: 0 };
    this.documents.splice(index, 1); return { acknowledged: true, deletedCount: 1 };
  }
  async createIndexes(indexes) { this.calls.push({ method: 'createIndexes', indexes }); for (const index of indexes) { const existing = this.indexes.get(index.name); if (existing) assert.deepEqual(existing, index); this.indexes.set(index.name, clone(index)); } return indexes.map(index => index.name); }
}
const setup = () => { const collection = new MemoryCollection(); return { collection, repository: createEventRepository(collection, { now: () => now }) }; };
const invalid = code => error => error instanceof EventDataError && error.code === code;

test('construction has no database side effects; create uses BSON ObjectId, Dates and verified creator', async () => {
  const { collection, repository } = setup(); assert.equal(collection.calls.length, 0);
  const values = input(), dto = await repository.createEvent(owner, values), document = collection.documents[0];
  assert(document._id instanceof ObjectId); assert(document.eventDate instanceof Date); assert(document.createdAt instanceof Date); assert(document.updatedAt instanceof Date);
  assert.equal(document.creatorId, owner.subject); assert.equal(document.createdAt.toISOString(), now.toISOString()); assert.equal(document.updatedAt.toISOString(), now.toISOString());
  assert.equal(dto.id, document._id.toHexString()); assert.equal(dto.eventDate, values.eventDate); assert.equal(dto.thumbnailAlt, `Event image: ${values.title}`);
  assert.equal(typeof values.eventDate, 'string'); assert.equal(Object.hasOwn(dto, '_id'), false);
  await assert.rejects(repository.createEvent(owner, { ...input(), creatorId: other.subject }), invalid('INVALID_EVENT_DATA'));
  assert.equal(collection.documents.length, 1);
});

test('creator email is required, normalized, private and immutable; historical events remain readable/editable', async () => {
  const { collection, repository } = setup();
  const dto = await repository.createEvent({ ...owner, creatorEmail: ' Owner@Example.Invalid ' }, input());
  assert.equal(collection.documents[0].creatorEmail, 'owner@example.invalid');
  assert.equal(Object.hasOwn(dto, 'creatorEmail'), false);
  for (const email of [undefined, '', 'invalid', 'a\nb@example.invalid']) {
    await assert.rejects(repository.createEvent({ ...owner, creatorEmail: email }, input()), invalid('CREATOR_ACCOUNT_UNAVAILABLE'));
  }
  for (const patch of [{ creatorEmail: 'attacker@example.invalid' }, { creatorId: other.subject }]) {
    await assert.rejects(repository.createEvent(owner, { ...input(), ...patch }), invalid('INVALID_EVENT_DATA'));
    await assert.rejects(repository.updateOwnedEvent(owner, dto.id, patch), invalid('INVALID_EVENT_DATA'));
  }
  await repository.updateOwnedEvent(other, dto.id, { title: 'Forbidden' });
  assert.equal(collection.documents[0].title, input().title);
  await repository.updateOwnedEvent(owner, dto.id, { title: 'Updated' });
  assert.equal(collection.documents[0].creatorEmail, 'owner@example.invalid');
  delete collection.documents[0].creatorEmail;
  assert.equal((await repository.findEventById(dto.id)).id, dto.id);
  assert.equal((await repository.updateOwnedEvent(owner, dto.id, { title: 'Historical' })).title, 'Historical');
  assert.equal(Object.hasOwn(collection.documents[0], 'creatorEmail'), false);
});

test('lookup returns an explicit DTO, handles missing documents and never returns MongoDB metadata', async () => {
  const { collection, repository } = setup(); const created = await repository.createEvent(owner, input());
  collection.documents[0].internalOnly = { privateDetail: 'do not expose' };
  const dto = await repository.findEventById(created.id); assert.deepEqual(dto, created);
  assert.deepEqual(Object.keys(dto).sort(), ['id','title','description','eventType','thumbnailUrl','thumbnailAlt','location','eventDate','creatorId','createdAt','updatedAt'].sort());
  const lookup = collection.calls.at(-1); assert.equal(lookup.options.projection._id, 1); assert.equal(lookup.options.projection.internalOnly, undefined);
  assert.equal(await repository.findEventById(new ObjectId().toHexString()), null);
});

test('invalid event IDs and write payloads fail before any database call', async () => {
  const { collection, repository } = setup(); const id = new ObjectId().toHexString();
  for (const value of [null, { $ne: null }, 'malformed']) {
    await assert.rejects(repository.findEventById(value), invalid('INVALID_EVENT_ID'));
    await assert.rejects(repository.updateOwnedEvent(owner, value, { title: 'New title' }), invalid('INVALID_EVENT_ID'));
    await assert.rejects(repository.deleteOwnedEvent(owner, value), invalid('INVALID_EVENT_ID'));
  }
  await assert.rejects(repository.createEvent(owner, {}), invalid('INVALID_EVENT_DATA'));
  await assert.rejects(repository.updateOwnedEvent(owner, id, { createdAt: now.toISOString() }), invalid('INVALID_EVENT_DATA'));
  await assert.rejects(repository.updateOwnedEvent(owner, id, { eventDate: now.toISOString() }), invalid('INVALID_EVENT_DATA'));
  assert.equal(collection.calls.length, 0);
});

test('all writes and creator listing reject absent/unverified-shaped identities', async () => {
  const { collection, repository } = setup(); const id = new ObjectId().toHexString();
  for (const auth of [null, {}, { email: 'test@example.invalid' }, { creatorId: owner.subject }]) {
    for (const operation of [() => repository.createEvent(auth, input()), () => repository.listEventsByCreator(auth), () => repository.updateOwnedEvent(auth, id, { title: 'New title' }), () => repository.deleteOwnedEvent(auth, id)]) await assert.rejects(operation(), invalid('AUTH_REQUIRED'));
  }
  assert.equal(collection.calls.length, 0);
});

test('updates atomically filter by ObjectId and creator, preserve immutable fields and return post-update DTO', async () => {
  const { collection, repository } = setup(); const created = await repository.createEvent(owner, input());
  const later = new Date(now.getTime() + 60000), writer = createEventRepository(collection, { now: () => later });
  const changed = await writer.updateOwnedEvent(owner, created.id, { title: 'Updated isolated title', eventDate: '2030-03-01T00:00:00.000Z' });
  assert.equal(changed.title, 'Updated isolated title'); assert.equal(changed.updatedAt, later.toISOString()); assert.equal(changed.createdAt, created.createdAt); assert.equal(changed.creatorId, owner.subject);
  const call = collection.calls.at(-1); assert.deepEqual(Object.keys(call.filter).sort(), ['_id','creatorId']); assert(call.filter._id.equals(created.id)); assert.equal(call.filter.creatorId, owner.subject);
  assert.equal(call.options.returnDocument, 'after'); assert.equal(call.options.includeResultMetadata, false); assert.equal(call.options.upsert, false);
  assert(call.update.$set.eventDate instanceof Date); assert.equal(call.update.$set.creatorId, undefined); assert.equal(call.update.$set.createdAt, undefined);
  assert.equal(collection.calls.filter(call => call.method === 'findOne').length, 0);
  assert.equal(await writer.updateOwnedEvent(other, created.id, { title: 'Must not apply' }), null);
  assert.equal(collection.documents[0].title, 'Updated isolated title');
});

test('ownership changes at write time prevent both updates and deletes without a preceding ownership read', async () => {
  for (const operation of ['update', 'delete']) {
    const { collection, repository } = setup(); const created = await repository.createEvent(owner, input());
    collection.beforeMutation = () => { collection.documents[0].creatorId = other.subject; };
    if (operation === 'update') assert.equal(await repository.updateOwnedEvent(owner, created.id, { title: 'Must not apply' }), null);
    else assert.equal(await repository.deleteOwnedEvent(owner, created.id), false);
    assert.equal(collection.documents.length, 1); assert.equal(collection.documents[0].title, created.title);
    assert.equal(collection.calls.filter(call => call.method === 'findOne').length, 0);
  }
});

test('deletes atomically enforce ownership and expose only a boolean result', async () => {
  const { collection, repository } = setup(); const created = await repository.createEvent(owner, input());
  assert.equal(await repository.deleteOwnedEvent(other, created.id), false); assert.equal(collection.documents.length, 1);
  assert.equal(await repository.deleteOwnedEvent(owner, created.id), true); assert.equal(collection.documents.length, 0);
  const call = collection.calls.at(-1); assert.deepEqual(Object.keys(call.filter).sort(), ['_id','creatorId']); assert(call.filter._id.equals(created.id)); assert.equal(call.filter.creatorId, owner.subject);
  assert.equal(await repository.deleteOwnedEvent(owner, created.id), false);
});

test('upcoming queries exclude past/current dates, sort date/ID ascending and apply MongoDB limit(6)', async () => {
  const { collection, repository } = setup();
  for (let index = 10; index >= 1; index--) await repository.createEvent(owner, { ...input(), title: `Isolated item ${index}`, eventDate: new Date(now.getTime() + index * 1000).toISOString() });
  // Age two in-memory records; they are never written to a real database.
  collection.documents[0].eventDate = new Date(now.getTime() - 1); collection.documents[1].eventDate = new Date(now);
  collection.documents[3].eventDate = new Date(collection.documents[2].eventDate);
  const expected = collection.documents.filter(document => document.eventDate > now).sort((a,b) => a.eventDate - b.eventDate || a._id.toHexString().localeCompare(b._id.toHexString()));
  const events = await repository.listUpcomingEvents(); assert.equal(events.length, 6); assert.deepEqual(events.map(event => event.id), expected.slice(0,6).map(document => document._id.toHexString()));
  const call = collection.calls.at(-1); assert.deepEqual(call.filter, { eventDate: { $gt: now } }); assert.deepEqual(call.sort, { eventDate: 1, _id: 1 }); assert.equal(call.limit, 6); assert.equal(call.skip, 0);
  assert.deepEqual((await repository.listUpcomingEvents({ page: 2 })).map(event => event.id), expected.slice(6,12).map(document => document._id.toHexString()));
});

test('creator lists isolate user records and pagination caps are applied to database cursors', async () => {
  const { collection, repository } = setup();
  for (let index = 0; index < 5; index++) await repository.createEvent(index % 2 ? other : owner, input());
  const mine = await repository.listEventsByCreator(owner, { page: 2, pageSize: 2 }); assert.equal(mine.length, 1); assert.equal(mine[0].creatorId, owner.subject);
  let call = collection.calls.at(-1); assert.deepEqual(call.filter, { creatorId: owner.subject }); assert.equal(call.skip, 2); assert.equal(call.limit, 2);
  await repository.listEventsByCreator(owner, { page: 1000, pageSize: 50 }); call = collection.calls.at(-1); assert.equal(call.skip, 49950); assert.equal(call.limit, 50);
  const count = collection.calls.length;
  for (const options of [{ page: 0 }, { page: 1001 }, { pageSize: 51 }, { limit: 500 }, { page: '1' }]) await assert.rejects(repository.listEventsByCreator(owner, options), invalid('INVALID_PAGINATION'));
  await assert.rejects(repository.listUpcomingEvents({ pageSize: 7 }), invalid('INVALID_PAGINATION')); assert.equal(collection.calls.length, count);
  assert.deepEqual(await setup().repository.listUpcomingEvents(), []);
});

test('index initialization is explicit and repeatable with stable specifications; ID lookup uses MongoDB _id_', async () => {
  const { collection, repository } = setup(); assert.equal(EVENT_COLLECTION_NAME, 'nn_events');
  await repository.initializeIndexes(); await repository.initializeIndexes(); assert.equal(collection.indexes.size, 2);
  assert.deepEqual(collection.calls[0].indexes, EVENT_INDEXES);
  assert.deepEqual(collection.indexes.get('events_upcoming_date_id').key, { eventDate: 1, _id: 1 });
  assert.deepEqual(collection.indexes.get('events_creator_date_id').key, { creatorId: 1, eventDate: 1, _id: 1 });
  assert.equal(collection.documents.length, 0);
});

test('every database failure and unacknowledged insert becomes a sanitized error with no driver cause', async () => {
  const id = new ObjectId().toHexString(), secret = 'SENSITIVE_DRIVER_DETAIL';
  const fail = () => { throw Object.assign(new Error(secret), { host: secret, connectionString: secret }); };
  const collection = { insertOne: fail, findOne: fail, find: fail, findOneAndUpdate: fail, deleteOne: fail, createIndexes: fail };
  const repository = createEventRepository(collection, { now: () => now });
  const check = error => error instanceof EventDataError && error.code === 'EVENT_STORE_UNAVAILABLE' && error.statusCode === 503 && error.message === 'Event data is temporarily unavailable.' && !error.cause && !JSON.stringify(error).includes(secret) && !error.stack.includes(secret);
  for (const operation of [() => repository.initializeIndexes(), () => repository.createEvent(owner, input()), () => repository.findEventById(id), () => repository.listUpcomingEvents(), () => repository.listEventsByCreator(owner), () => repository.updateOwnedEvent(owner, id, { title: 'New title' }), () => repository.deleteOwnedEvent(owner, id)]) await assert.rejects(operation(), check);
  await assert.rejects(createEventRepository({ insertOne: async () => ({ acknowledged: false }) }, { now: () => now }).createEvent(owner, input()), check);
  await assert.rejects(createEventRepository({ deleteOne: async () => ({ acknowledged: false }) }, { now: () => now }).deleteOwnedEvent(owner, id), check);
  await assert.rejects(createEventRepository(collection, { now: () => { throw Error(secret); } }).createEvent(owner, input()), check);
});

test('asynchronous cursor and malformed stored-date failures are sanitized too', async () => {
  const { collection, repository } = setup(); const created = await repository.createEvent(owner, input());
  collection.documents[0].eventDate = 'not a BSON Date'; await assert.rejects(repository.findEventById(created.id), invalid('EVENT_STORE_UNAVAILABLE'));
  collection.find = () => ({ sort() { return this; }, skip() { return this; }, limit() { return this; }, async toArray() { throw Error('SENSITIVE_CURSOR_DETAIL'); } });
  await assert.rejects(repository.listUpcomingEvents(), invalid('EVENT_STORE_UNAVAILABLE'));
});
