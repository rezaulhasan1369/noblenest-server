import { ObjectId } from 'mongodb';
import { EventDataError, validateEventInput, parseEventId, verifiedCreatorId, normalizedCreatorEmail, eventPagination, eventDto } from './event-model.js';

export const EVENT_COLLECTION_NAME = 'nn_events';
export const EVENT_INDEXES = Object.freeze([
  Object.freeze({ name: 'events_upcoming_date_id', key: Object.freeze({ eventDate: 1, _id: 1 }) }),
  Object.freeze({ name: 'events_creator_date_id', key: Object.freeze({ creatorId: 1, eventDate: 1, _id: 1 }) }),
]);
const projection = Object.freeze({ _id: 1, title: 1, description: 1, eventType: 1, thumbnailUrl: 1, thumbnailAlt: 1, location: 1, eventDate: 1, creatorId: 1, createdAt: 1, updatedAt: 1 });
const sort = Object.freeze({ eventDate: 1, _id: 1 });

// Inject a collection and clock; importing/constructing this module opens no
// connection, initializes no index and performs no database operation.
export function createEventRepository(collection, { now = () => new Date() } = {}) {
  if (!collection || typeof now !== 'function') throw new TypeError('An event collection and server clock are required.');
  function timestamp() {
    try {
      const value = now();
      if (!(value instanceof Date) || !Number.isFinite(value.getTime())) throw Error();
      return new Date(value.getTime());
    } catch { throw new EventDataError('EVENT_STORE_UNAVAILABLE', 'Event data is temporarily unavailable.', 503); }
  }
  async function database(operation) {
    try { return await operation(); }
    catch {
      // No raw error, cause, host, collection detail or driver metadata escapes.
      throw new EventDataError('EVENT_STORE_UNAVAILABLE', 'Event data is temporarily unavailable.', 503);
    }
  }
  return Object.freeze({
    async initializeIndexes() {
      // MongoDB's built-in unique _id_ index already covers ID lookups. Stable
      // names/specs make repeated initialization safe; never drop/rebuild indexes.
      await database(() => collection.createIndexes(EVENT_INDEXES.map(index => ({ name: index.name, key: { ...index.key } }))));
    },
    async createEvent(auth, input) {
      const creatorId = verifiedCreatorId(auth), time = timestamp();
      const values = validateEventInput(input, { now: time });
      const creatorEmail = normalizedCreatorEmail(auth.creatorEmail);
      const document = { ...values, _id: new ObjectId(), creatorId, creatorEmail, createdAt: time, updatedAt: time };
      document.thumbnailAlt ??= `Event image: ${document.title}`;
      return database(async () => {
        const result = await collection.insertOne(document);
        if (!result.acknowledged) throw Error();
        return eventDto(document);
      });
    },
    async findEventById(id) {
      const _id = parseEventId(id);
      return database(async () => {
        const document = await collection.findOne({ _id }, { projection });
        return document ? eventDto(document) : null;
      });
    },
    async listUpcomingEvents(options = {}) {
      const { skip, limit } = eventPagination(options, { upcoming: true }), time = timestamp();
      return database(async () => (await collection.find({ eventDate: { $gt: time } }, { projection })
        .sort(sort).skip(skip).limit(limit).toArray()).map(eventDto));
    },
    async listEventsByCreator(auth, options = {}) {
      const creatorId = verifiedCreatorId(auth), { skip, limit } = eventPagination(options);
      return database(async () => (await collection.find({ creatorId }, { projection })
        .sort(sort).skip(skip).limit(limit).toArray()).map(eventDto));
    },
    async updateOwnedEvent(auth, id, input) {
      const creatorId = verifiedCreatorId(auth), _id = parseEventId(id), time = timestamp();
      const values = validateEventInput(input, { partial: true, now: time });
      return database(async () => {
        const document = await collection.findOneAndUpdate(
          { _id, creatorId }, { $set: { ...values, updatedAt: time } },
          { returnDocument: 'after', includeResultMetadata: false, projection, upsert: false },
        );
        return document ? eventDto(document) : null;
      });
    },
    async deleteOwnedEvent(auth, id) {
      const creatorId = verifiedCreatorId(auth), _id = parseEventId(id);
      return database(async () => {
        const result = await collection.deleteOne({ _id, creatorId });
        if (!result.acknowledged) throw Error();
        return result.deletedCount === 1;
      });
    },
  });
}
