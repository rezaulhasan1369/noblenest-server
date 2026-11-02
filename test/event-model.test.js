import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ObjectId } from 'mongodb';
import { EventDataError, EVENT_TYPES, EVENT_LIMITS, validateEventInput, parseEventId, verifiedCreatorId, eventPagination, normalizedCreatorEmail } from '../src/event-model.js';

const now = new Date('2030-01-01T00:00:00.000Z');
const valid = () => ({ title: ' Isolated event test ', description: 'A test description.', eventType: 'Cleanup', thumbnailUrl: 'https://images.example.invalid/event.webp', location: 'Test location', eventDate: '2030-01-02T09:00:00.000Z' });
const rejects = (callback, code = 'INVALID_EVENT_DATA') => assert.throws(callback, error => error instanceof EventDataError && error.code === code && !error.cause);
test('creator email normalization rejects invalid account values and mass assignment', () => {
  assert.equal(normalizedCreatorEmail(' User@Example.Invalid '), 'user@example.invalid');
  for (const value of [null, {}, '', 'bad', 'a\nb@example.invalid', 'x'.repeat(255) + '@example.invalid']) rejects(() => normalizedCreatorEmail(value), 'CREATOR_ACCOUNT_UNAVAILABLE');
  for (const partial of [false, true]) rejects(() => validateEventInput({ ...valid(), creatorEmail: 'spoof@example.invalid' }, { partial, now }));
});

test('event validation trims text, accepts exact form categories and produces a BSON-compatible UTC Date', () => {
  const input = valid();
  for (const eventType of EVENT_TYPES) {
    const result = validateEventInput({ ...input, eventType }, { now });
    assert.equal(result.title, 'Isolated event test');
    assert(result.eventDate instanceof Date);
    assert.equal(result.eventDate.toISOString(), input.eventDate);
  }
  assert.equal(input.title, ' Isolated event test ');
  assert.equal(typeof input.eventDate, 'string');
});

test('required text fields, wrong types, missing fields and optional alt text are validated', () => {
  for (const field of ['title', 'description', 'eventType', 'thumbnailUrl', 'location', 'eventDate']) {
    const missing = valid(); delete missing[field]; rejects(() => validateEventInput(missing, { now }));
    for (const bad of ['', '   ', null, 3, [], { $ne: null }]) rejects(() => validateEventInput({ ...valid(), [field]: bad }, { now }));
  }
  for (const bad of [null, [], 'text', new Date(), Object.create({ title: 'inherited' })]) rejects(() => validateEventInput(bad, { now }));
  rejects(() => validateEventInput({ ...valid(), thumbnailAlt: '' }, { now }));
  assert.equal(validateEventInput({ ...valid(), thumbnailAlt: ' Descriptive alternative ' }, { now }).thumbnailAlt, 'Descriptive alternative');
});

test('server length limits match the client DTO and cannot be bypassed with whitespace', () => {
  for (const field of ['title', 'description', 'location', 'thumbnailAlt']) {
    const text = 'x'.repeat(EVENT_LIMITS[field]);
    assert.equal(validateEventInput({ ...valid(), [field]: text }, { now })[field], text);
    rejects(() => validateEventInput({ ...valid(), [field]: text + ' ' }, { now }));
  }
  const url = 'https://images.example.invalid/'.padEnd(2048, 'a');
  assert.equal(validateEventInput({ ...valid(), thumbnailUrl: url }, { now }).thumbnailUrl, url);
  rejects(() => validateEventInput({ ...valid(), thumbnailUrl: url + 'a' }, { now }));
});

test('invalid categories and non-HTTPS, credential-bearing or ambiguous thumbnail URLs are rejected', () => {
  for (const eventType of ['Environmental Cleanup', 'cleanup', 'Other', 'x'.repeat(81)]) rejects(() => validateEventInput({ ...valid(), eventType }, { now }));
  for (const thumbnailUrl of ['http://images.example.invalid/a', '/event-images/optimized/sample.webp', '//images.example.invalid/a', 'javascript:alert(1)', 'data:image/png;base64,abc', 'https://user:password@images.example.invalid/a', 'https://images.example.invalid\\a', 'https://images.example.invalid/a\nb', 'https:images.example.invalid/a', 'not a URL']) rejects(() => validateEventInput({ ...valid(), thumbnailUrl }, { now }));
});

test('past/current, invalid calendar dates and ambiguous timestamps cannot become event dates', () => {
  for (const eventDate of ['2029-12-31T23:59:59.999Z', now.toISOString(), '2030-02-30T09:00:00.000Z', '2030-01-02', '2030-01-02T09:00', '2030-01-02T09:00:00+06:00', 'invalid', new Date('2030-01-02')]) rejects(() => validateEventInput({ ...valid(), eventDate }, { now }));
});

test('creator, ID, timestamps, operators, prototype fields and unknown writable properties are rejected', () => {
  for (const field of ['creatorId', 'userId', 'email', '_id', 'id', 'createdAt', 'updatedAt', '$set', 'unexpected', 'constructor']) {
    rejects(() => validateEventInput({ ...valid(), [field]: 'untrusted' }, { now }));
    rejects(() => validateEventInput({ [field]: 'untrusted' }, { now, partial: true }));
  }
  rejects(() => validateEventInput(JSON.parse('{"__proto__":{"creatorId":"other"}}'), { now, partial: true }));
  rejects(() => validateEventInput({ ...valid(), [Symbol('hidden')]: 'untrusted' }, { now }));
  const accessor = { ...valid() }; Object.defineProperty(accessor, 'title', { get() { throw Error('must not execute'); } });
  rejects(() => validateEventInput(accessor, { now }));
  rejects(() => validateEventInput({}, { now, partial: true }));
  assert.deepEqual(validateEventInput({ title: ' Revised title ' }, { now, partial: true }), { title: 'Revised title' });
});

test('event identifiers accept only 24 hexadecimal characters', () => {
  const id = new ObjectId(); assert(parseEventId(id.toHexString().toUpperCase()).equals(id));
  for (const value of [null, undefined, {}, { $ne: null }, [], 12, '', 'abcdefghijkl', 'x'.repeat(24), 'a'.repeat(23), 'a'.repeat(25), id]) rejects(() => parseEventId(value), 'INVALID_EVENT_ID');
});

test('writes require the verified identity shape and event scope, not an email or submitted creator ID', () => {
  const auth = { subject: 'opaque-user', sessionId: 'opaque-session', scopes: ['noblenest:events'] };
  assert.equal(verifiedCreatorId(auth), 'opaque-user');
  for (const value of [null, {}, { email: 'user@example.invalid' }, { creatorId: 'opaque-user' }, { ...auth, subject: ' ' }, { ...auth, subject: 'x'.repeat(129) }, { ...auth, sessionId: '' }, { ...auth, scopes: ['other'] }]) rejects(() => verifiedCreatorId(value), 'AUTH_REQUIRED');
});

test('pagination is strict and bounded; homepage reads always use six with no caller override', () => {
  assert.deepEqual(eventPagination(), { skip: 0, limit: 12 });
  assert.deepEqual(eventPagination({ page: 1000, pageSize: 50 }), { skip: 49950, limit: 50 });
  assert.deepEqual(eventPagination({ page: 2 }, { upcoming: true }), { skip: 6, limit: 6 });
  for (const input of [null, [], { page: 0 }, { page: -1 }, { page: 1.5 }, { page: '2' }, { page: 1001 }, { page: Infinity }, { pageSize: 0 }, { pageSize: 51 }, { pageSize: '6' }, { offset: 10 }, { limit: 500 }, { sort: { creatorId: 1 } }]) rejects(() => eventPagination(input), 'INVALID_PAGINATION');
  for (const pageSize of [1, 6, 7, 50, 500]) rejects(() => eventPagination({ pageSize }, { upcoming: true }), 'INVALID_PAGINATION');
});
