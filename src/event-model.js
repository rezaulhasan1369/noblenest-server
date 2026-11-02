import { ObjectId } from 'mongodb';

export const EVENT_TYPES = Object.freeze(['Cleanup', 'Plantation', 'Donation', 'Community service']);
export const EVENT_LIMITS = Object.freeze({ title: 200, description: 5000, eventType: 80, thumbnailUrl: 2048, thumbnailAlt: 300, location: 300 });
export const HOMEPAGE_EVENT_LIMIT = 6;
export const MAX_EVENT_PAGE = 1000;
export const MAX_EVENT_PAGE_SIZE = 50;
const requiredFields = ['title', 'description', 'eventType', 'thumbnailUrl', 'location', 'eventDate'];
const writableFields = new Set([...requiredFields, 'thumbnailAlt']);

export class EventDataError extends Error {
  constructor(code, message, statusCode = 400) {
    super(message);
    this.name = 'EventDataError';
    this.code = code;
    this.statusCode = statusCode;
  }
}

// Only call with an account value loaded by the trusted authorization layer.
export function normalizedCreatorEmail(value) {
  if (typeof value !== 'string' || value.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim())) {
    throw new EventDataError('CREATOR_ACCOUNT_UNAVAILABLE', 'Creator account is unavailable.', 503);
  }
  return value.trim().toLowerCase();
}

function isRecord(value) {
  return value !== null && typeof value === 'object' &&
    [Object.prototype, null].includes(Object.getPrototypeOf(value));
}

function invalid(message = 'Invalid event data.') {
  throw new EventDataError('INVALID_EVENT_DATA', message);
}

export function parseEventId(value) {
  if (typeof value !== 'string' || !/^[a-f\d]{24}$/i.test(value)) {
    throw new EventDataError('INVALID_EVENT_ID', 'Invalid event identifier.');
  }
  return new ObjectId(value);
}

// Shape checks are defense in depth, not authentication. Callers must supply
// req.auth produced by the existing JWT middleware, never a request-body object.
export function verifiedCreatorId(auth) {
  const validId = value => typeof value === 'string' && value.length > 0 && value.length <= 128 && !/[\s\u0000-\u001f\u007f]/.test(value);
  if (!auth || !validId(auth.subject) || !validId(auth.sessionId) || !Array.isArray(auth.scopes) || !auth.scopes.includes('noblenest:events')) {
    throw new EventDataError('AUTH_REQUIRED', 'Verified authentication is required.', 401);
  }
  return auth.subject;
}

export function validateEventInput(input, { partial = false, now = new Date() } = {}) {
  if (!isRecord(input)) invalid();
  const keys = Reflect.ownKeys(input);
  if (!keys.length || keys.some(key => !writableFields.has(key) || !Object.hasOwn(Object.getOwnPropertyDescriptor(input, key), 'value'))) {
    invalid('Unexpected or empty event fields.');
  }
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) throw new TypeError('A valid server clock is required.');
  if (!partial && requiredFields.some(key => !Object.hasOwn(input, key))) invalid('Required event fields are missing.');
  const values = {};
  for (const field of keys) {
    const value = input[field];
    if (typeof value !== 'string' || !value.trim() || value.length > (EVENT_LIMITS[field] || 24)) invalid(`Invalid ${field}.`);
    const text = value.trim();
    if (field === 'eventDate') {
      // Match the existing canonical UTC DTO contract; reject timezone ambiguity
      // and dates normalized by Date.parse, such as February 30.
      const date = new Date(text);
      if (text.length !== 24 || !Number.isFinite(date.getTime()) || date.toISOString() !== text || date <= now) invalid('A future UTC event date is required.');
      values.eventDate = date;
    } else {
      if (field === 'eventType' && !EVENT_TYPES.includes(text)) invalid('Invalid event category.');
      if (field === 'thumbnailUrl') {
        let url;
        try { url = new URL(text); } catch { invalid('Invalid HTTPS thumbnail URL.'); }
        if (!text.startsWith('https://') || /[\s\\\u0000-\u001f\u007f]/.test(text) || url.protocol !== 'https:' || !url.hostname || url.username || url.password) invalid('Invalid HTTPS thumbnail URL.');
      }
      values[field] = text;
    }
  }
  return values;
}

export function eventPagination(input = {}, { upcoming = false } = {}) {
  const invalidPage = () => { throw new EventDataError('INVALID_PAGINATION', 'Invalid event pagination.'); };
  if (!isRecord(input) || Reflect.ownKeys(input).some(key => !(upcoming ? ['page'] : ['page', 'pageSize']).includes(key))) invalidPage();
  const page = input.page === undefined ? 1 : input.page;
  const pageSize = upcoming ? HOMEPAGE_EVENT_LIMIT : input.pageSize === undefined ? 12 : input.pageSize;
  if (!Number.isSafeInteger(page) || page < 1 || page > MAX_EVENT_PAGE || !Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > MAX_EVENT_PAGE_SIZE) invalidPage();
  return { skip: (page - 1) * pageSize, limit: pageSize };
}

// Explicit DTO projection: never spread a MongoDB document or driver result.
export function eventDto(document) {
  return {
    id: document._id.toHexString(), title: document.title, description: document.description,
    eventType: document.eventType, thumbnailUrl: document.thumbnailUrl, thumbnailAlt: document.thumbnailAlt,
    location: document.location, eventDate: document.eventDate.toISOString(), creatorId: document.creatorId,
    createdAt: document.createdAt.toISOString(), updatedAt: document.updatedAt.toISOString(),
  };
}
