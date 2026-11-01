import { ObjectId } from 'mongodb';
import { EventDataError, eventDto, eventPagination, parseEventId, verifiedCreatorId } from './event-model.js';
import { EVENT_COLLECTION_NAME } from './event-repository.js';

export const PARTICIPATION_COLLECTION_NAME = 'nn_event_participants';
export const PARTICIPATION_INDEXES = Object.freeze([
  Object.freeze({ name: 'participants_event_user_unique', key: Object.freeze({ eventId: 1, userId: 1 }), unique: true }),
  Object.freeze({ name: 'participants_user_event', key: Object.freeze({ userId: 1, eventId: 1 }) }),
]);
const projection = { _id: 1, eventId: 1, userId: 1, joinedAt: 1 };
const eventProjection = { _id: 1, title: 1, description: 1, eventType: 1, thumbnailUrl: 1, thumbnailAlt: 1, location: 1, eventDate: 1, creatorId: 1, createdAt: 1, updatedAt: 1 };
function unavailable() { return new EventDataError('PARTICIPATION_STORE_UNAVAILABLE', 'Participation data is temporarily unavailable.', 503); }
function sameKeys(key) {
  return key && JSON.stringify(Object.entries(key)) === JSON.stringify([['eventId', 1], ['userId', 1]]);
}
function participationDto(document) {
  return { id: document._id.toHexString(), eventId: document.eventId.toHexString(), joinedAt: document.joinedAt.toISOString() };
}

// Construction is side-effect free. No client, index initialization or command
// is run until a repository operation is explicitly requested.
export function createParticipationRepository(participants, events, { now = () => new Date() } = {}) {
  if (!participants || !events || typeof now !== 'function') throw TypeError('Participation collections and clock are required.');
  return Object.freeze({
    async joinEvent(auth, id) {
      const userId = verifiedCreatorId(auth), eventId = parseEventId(id);
      try {
        if (!await events.findOne({ _id: eventId }, { projection: { _id: 1 } })) {
          throw new EventDataError('EVENT_NOT_FOUND', 'Event not found.', 404);
        }
        // Read metadata on every join and fail closed. No flag/cache can turn
        // this prerequisite off, and this code never creates an index.
        const indexes = await participants.listIndexes().toArray();
        const index = indexes.find(index => typeof index.name === 'string' && sameKeys(index.key) && index.unique === true && !index.hidden && !index.sparse && !index.partialFilterExpression && (!index.collation || index.collation.locale === 'simple') && !index.prepareUnique && !index.buildUUID);
        if (!index) throw unavailable();
        // listIndexes can include a build in progress. A successful hinted read
        // confirms the selected visible index is usable, not just catalogued.
        // This read is NOT duplicate prevention: the unique insert is authority.
        await participants.findOne({ eventId, userId }, { projection: { _id: 1 }, hint: index.name });
        const time = now();
        if (!(time instanceof Date) || !Number.isFinite(+time)) throw unavailable();
        const document = { _id: new ObjectId(), eventId, userId, joinedAt: new Date(+time) };
        try {
          const result = await participants.insertOne(document);
          if (!result.acknowledged) throw unavailable();
          return { created: true, participation: participationDto(document) };
        } catch (error) {
          if (error.code !== 11000) throw error;
          // A duplicate-key error alone is not evidence of this user's join:
          // recover only an existing row matching the exact verified pair.
          const existing = await participants.findOne({ eventId, userId }, { projection });
          if (!existing) throw unavailable();
          return { created: false, participation: participationDto(existing) };
        }
      } catch (error) {
        if (error instanceof EventDataError && error.code === 'EVENT_NOT_FOUND') throw error;
        throw unavailable();
      }
    },
    async listJoinedEvents(auth, options = {}) {
      const userId = verifiedCreatorId(auth), { skip, limit } = eventPagination(options);
      try {
        const documents = await participants.aggregate([
          { $match: { userId } },
          { $lookup: { from: EVENT_COLLECTION_NAME, localField: 'eventId', foreignField: '_id', pipeline: [{ $project: eventProjection }], as: 'event' } },
          // Inner-join behavior removes deleted/missing events before paging.
          { $unwind: '$event' },
          { $sort: { 'event.eventDate': 1, 'event._id': 1, _id: 1 } },
          { $skip: skip }, { $limit: limit },
          { $project: { _id: 1, joinedAt: 1, event: 1 } },
        ], { maxTimeMS: 5000, allowDiskUse: false }).toArray();
        return documents.map(document => ({ participationId: document._id.toHexString(), joinedAt: document.joinedAt.toISOString(), event: eventDto(document.event) }));
      } catch { throw unavailable(); }
    },
  });
}
