import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BSON, ObjectId } from 'mongodb';
import { createEventLifecycle } from '../src/event-lifecycle.js';
import { createEventStore } from '../src/event-store.js';

const id = n => new ObjectId(n.toString(16).padStart(24, '0'));
const clone = x => BSON.deserialize(BSON.serialize({ value: x })).value;
const auth = subject => ({ subject, sessionId: 'isolated-session', scopes: ['noblenest:events'] });
const clock = new Date('2030-01-01T00:00:00.000Z');
const row = (eventId, userId = 'member') => ({ _id: new ObjectId(), eventId, userId, joinedAt: clock });

// Optimistic transaction model only: no MongoClient, sockets, environment files
// or Atlas data. Commit conflicts are retried against a fresh snapshot, modeling
// the driver/server contract; this is not proof of live MongoDB execution.
function fixture() {
  const target = id(1), other = id(2), historic = id(3);
  let state = { events: [{ _id: target, creatorId: 'owner' }, { _id: other, creatorId: 'other' }], participants: [row(target), row(other), row(historic)] };
  let version = 0;
  const calls = [], options = [], controls = { failCleanup: false, failInsert: false, unsupported: false, duplicateOnce: false, hiddenIndex: false, unackedCleanup: false, unackedInsert: false };
  function snapshot(session) { assert(session?.state, 'every data operation must carry its own session'); return session.state; }
  const client = { async withSession(work) {
    const session = { async withTransaction(operation, opts) {
      options.push(opts);
      if (controls.unsupported) throw Error('PRIVATE unsupported transaction');
      for (let attempt = 0; attempt < 10; attempt++) {
        const started = version; session.state = clone(state);
        const result = await operation(session);
        await Promise.resolve();
        if (started !== version) { calls.push('conflict-retry'); continue; }
        state = session.state; version++; return result;
      }
      throw Error('retry bound');
    } };
    try { return await work(session); } finally { calls.push('session-ended'); }
  } };
  const events = {
    async deleteOne(filter, { session }) {
      calls.push({ kind: 'delete', filter }); const s = snapshot(session);
      const i = s.events.findIndex(e => e._id.equals(filter._id) && e.creatorId === filter.creatorId);
      if (i < 0) return { acknowledged: true, deletedCount: 0 };
      s.events.splice(i, 1); return { acknowledged: true, deletedCount: 1 };
    },
    async updateOne(filter, update, { session }) {
      calls.push({ kind: 'parent-lock', filter, update }); const s = snapshot(session);
      const e = s.events.find(e => e._id.equals(filter._id));
      if (e) e.participationVersion = (e.participationVersion || 0) + update.$inc.participationVersion;
      await Promise.resolve();
      return { acknowledged: true, matchedCount: e ? 1 : 0 };
    },
  };
  const participants = {
    listIndexes() { return { toArray: async () => [{ name: 'pair', key: { eventId: 1, userId: 1 }, unique: true, hidden: controls.hiddenIndex }] }; },
    async deleteMany(filter, { session }) {
      calls.push({ kind: 'cleanup', filter }); const s = snapshot(session);
      if (controls.failCleanup) throw Error('PRIVATE cleanup failure');
      s.participants = s.participants.filter(p => !p.eventId.equals(filter.eventId));
      return { acknowledged: !controls.unackedCleanup };
    },
    async findOne(filter, { session, hint }) {
      assert.equal(hint, 'pair'); return snapshot(session).participants.find(p => p.eventId.equals(filter.eventId) && p.userId === filter.userId) ?? null;
    },
    async insertOne(document, { session }) {
      const s = snapshot(session);
      if (controls.failInsert) throw Error('PRIVATE insertion failure');
      if (controls.duplicateOnce) { controls.duplicateOnce = false; throw Object.assign(Error('PRIVATE duplicate'), { code: 11000 }); }
      assert(!s.participants.some(p => p.eventId.equals(document.eventId) && p.userId === document.userId));
      s.participants.push(document); return { acknowledged: !controls.unackedInsert };
    },
  };
  return { target, other, historic, client, events, participants, controls, calls, options, state: () => state, lifecycle: createEventLifecycle(client, events, participants, { now: () => clock }) };
}
const unavailable = e => e.statusCode === 503 && !e.message.includes('PRIVATE');

test('owner deletion atomically cleans only its event; unrelated and historical orphan rows survive', async () => {
  const f = fixture(); assert.equal(f.calls.length, 0);
  assert.equal(await f.lifecycle.deleteOwnedEvent(auth('owner'), f.target.toHexString()), true);
  assert.equal(f.state().events.length, 1);
  assert.deepEqual(f.state().participants.map(p => p.eventId.toHexString()), [f.other, f.historic].map(x => x.toHexString()));
  assert.deepEqual(f.options[0], { readConcern: { level: 'snapshot' }, writeConcern: { w: 'majority' }, readPreference: 'primary', maxCommitTimeMS: 5000 });
  assert.equal(f.calls.at(-1), 'session-ended');
});

test('non-owner and missing-event deletion never clean participations', async () => {
  const f = fixture(), before = clone(f.state());
  assert.equal(await f.lifecycle.deleteOwnedEvent(auth('intruder'), f.target.toHexString()), false);
  assert.equal(await f.lifecycle.deleteOwnedEvent(auth('owner'), id(99).toHexString()), false);
  assert.deepEqual(f.state(), before); assert(!f.calls.some(c => c.kind === 'cleanup'));
});

test('cleanup failure rolls back the parent deletion and returns a sanitized 503', async () => {
  const f = fixture(), before = clone(f.state()); f.controls.failCleanup = true;
  await assert.rejects(f.lifecycle.deleteOwnedEvent(auth('owner'), f.target.toHexString()), unavailable);
  assert.deepEqual(f.state(), before); assert.equal(f.calls.at(-1), 'session-ended');
});

test('join and duplicate join preserve one row and original DTO while locking the parent', async () => {
  const f = fixture();
  const a = await f.lifecycle.joinEvent(auth('new-member'), f.target.toHexString());
  const b = await f.lifecycle.joinEvent(auth('new-member'), f.target.toHexString());
  assert.equal(a.created, true); assert.equal(b.created, false); assert.deepEqual(a.participation, b.participation);
  assert.equal(f.state().participants.filter(p => p.userId === 'new-member').length, 1);
  assert.deepEqual(f.calls.find(c => c.kind === 'parent-lock').update, { $inc: { participationVersion: 1 } });
  assert.deepEqual(Object.keys(a.participation).sort(), ['eventId', 'id', 'joinedAt']);
});

test('failed join rolls back parent lock; unsupported transactions fail closed with no fallback', async () => {
  for (const failure of ['failInsert', 'unsupported']) {
    const f = fixture(), before = clone(f.state()); f.controls[failure] = true;
    await assert.rejects(f.lifecycle.joinEvent(auth('new-member'), f.target.toHexString()), unavailable);
    assert.deepEqual(f.state(), before);
    if (failure === 'unsupported') await assert.rejects(f.lifecycle.deleteOwnedEvent(auth('owner'), f.target.toHexString()), unavailable);
  }
});

test('missing parent and unusable unique index cannot create participation', async () => {
  const f = fixture();
  await assert.rejects(f.lifecycle.joinEvent(auth('new-member'), id(99).toHexString()), e => e.statusCode === 404);
  f.controls.hiddenIndex = true;
  await assert.rejects(f.lifecycle.joinEvent(auth('new-member'), f.target.toHexString()), unavailable);
  assert.equal(f.state().participants.length, 3);
});

test('duplicate-key recovery uses a fresh transaction rather than an aborted session', async () => {
  const f = fixture(); f.controls.duplicateOnce = true;
  const r = await f.lifecycle.joinEvent(auth('new-member'), f.target.toHexString());
  assert.equal(r.created, true); assert.equal(f.options.length, 2);
  assert.equal(f.state().events[0].participationVersion, 1);
});

test('both concurrent join/delete orderings leave no participation for the deleted event', async () => {
  for (const reverse of [false, true]) {
    const f = fixture();
    const actions = [() => f.lifecycle.joinEvent(auth('new-member'), f.target.toHexString()), () => f.lifecycle.deleteOwnedEvent(auth('owner'), f.target.toHexString())];
    if (reverse) actions.reverse();
    const settled = await Promise.allSettled(actions.map(a => a()));
    assert(!f.state().events.some(e => e._id.equals(f.target)));
    assert(!f.state().participants.some(p => p.eventId.equals(f.target)));
    for (const r of settled) if (r.status === 'rejected') assert.equal(r.reason.statusCode, 404);
    assert(f.calls.includes('conflict-retry'));
  }
});

test('authentication/ID validation occurs before sessions or catalog access', async () => {
  const f = fixture();
  for (const operation of ['joinEvent', 'deleteOwnedEvent']) {
    await assert.rejects(f.lifecycle[operation](null, f.target.toHexString()), e => e.code === 'AUTH_REQUIRED');
    await assert.rejects(f.lifecycle[operation](auth('owner'), 'bad'), e => e.code === 'INVALID_EVENT_ID');
  }
  assert.equal(f.options.length, 0);
});

test('runtime event store routes delete and join through transaction lifecycle and fails closed without session support', async () => {
  class Client { db() { return { collection() { return {}; } }; } async close() {} }
  const store = createEventStore({ mongoUri: 'mongodb://unused.invalid', dbName: 'noblenest', nodeEnv: 'test' }, { Client });
  await assert.rejects(store.repository.deleteOwnedEvent(auth('owner'), id(1).toHexString()), unavailable);
  await assert.rejects(store.participationRepository.joinEvent(auth('owner'), id(1).toHexString()), unavailable);
  await store.close();
});

test('unacknowledged cleanup/insertion rolls back the entire transaction', async () => {
  for (const failure of ['unackedCleanup', 'unackedInsert']) {
    const f = fixture(), before = clone(f.state()); f.controls[failure] = true;
    const operation = failure === 'unackedCleanup'
      ? f.lifecycle.deleteOwnedEvent(auth('owner'), f.target.toHexString())
      : f.lifecycle.joinEvent(auth('new-member'), f.target.toHexString());
    await assert.rejects(operation, unavailable);
    assert.deepEqual(f.state(), before);
  }
});

test('successful runtime store uses coordinated join/delete while preserving unrelated participants', async () => {
  const f = fixture();
  class Client {
    db() { return { collection(name) { return name === 'nn_events' ? f.events : f.participants; } }; }
    withSession(callback) { return f.client.withSession(callback); }
    async close() {}
  }
  const store = createEventStore({ mongoUri: 'mongodb://unused.invalid', dbName: 'noblenest', nodeEnv: 'test' }, { Client });
  const joined = await store.participationRepository.joinEvent(auth('new-member'), f.target.toHexString());
  assert.equal(joined.created, true);
  assert.equal(await store.repository.deleteOwnedEvent(auth('owner'), f.target.toHexString()), true);
  assert(!f.state().participants.some(p => p.eventId.equals(f.target)));
  assert.equal(f.state().participants.length, 2);
  await store.close();
});
