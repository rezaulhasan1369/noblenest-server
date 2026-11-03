import { ObjectId } from 'mongodb';
import { EventDataError, parseEventId, verifiedCreatorId } from './event-model.js';

function unavailable(participation = false) {
  return new EventDataError(participation ? 'PARTICIPATION_STORE_UNAVAILABLE' : 'EVENT_STORE_UNAVAILABLE', participation ? 'Participation data is temporarily unavailable.' : 'Event data is temporarily unavailable.', 503);
}
function missing() { return new EventDataError('EVENT_NOT_FOUND', 'Event not found.', 404); }
function participationDto(row) {
  return { id: row._id.toHexString(), eventId: row.eventId.toHexString(), joinedAt: row.joinedAt.toISOString() };
}

// Runtime mutations share one client's sessions. No connection or database work
// occurs at construction. There is deliberately no non-transactional fallback.
export function createEventLifecycle(client, events, participants, { now = () => new Date() } = {}) {
  async function transaction(operation) {
    return client.withSession(session => session.withTransaction(() => operation(session), {
      readConcern: { level: 'snapshot' }, writeConcern: { w: 'majority' },
      readPreference: 'primary', maxCommitTimeMS: 5000,
    }));
  }
  return Object.freeze({
    async deleteOwnedEvent(auth, id) {
      const creatorId = verifiedCreatorId(auth), eventId = parseEventId(id);
      try {
        return await transaction(async session => {
          const deleted = await events.deleteOne({ _id: eventId, creatorId }, { session });
          if (!deleted.acknowledged) throw unavailable();
          if (deleted.deletedCount !== 1) return false;
          const cleaned = await participants.deleteMany({ eventId }, { session });
          if (!cleaned.acknowledged) throw unavailable();
          return true;
        });
      } catch { throw unavailable(); }
    },
    async joinEvent(auth, id) {
      const userId = verifiedCreatorId(auth), eventId = parseEventId(id);
      try {
        // Catalog commands stay outside the transaction. The hinted read below
        // still verifies that the exact full unique pair index is usable.
        const indexes = await participants.listIndexes().toArray();
        const index = indexes.find(i => typeof i.name === 'string' && JSON.stringify(Object.entries(i.key || {})) === JSON.stringify([['eventId', 1], ['userId', 1]]) && i.unique === true && !i.hidden && !i.sparse && !i.partialFilterExpression && (!i.collation || i.collation.locale === 'simple') && !i.prepareUnique && !i.buildUUID);
        if (!index) throw unavailable(true);
        // A duplicate-key error aborts a transaction. Recovery must start a new
        // transaction, never issue another read in the aborted session.
        for (let attempt = 0; attempt < 2; attempt++) {
          try {
            return await transaction(async session => {
              // A real write to the parent serializes joins against deletion.
              // A snapshot-only existence read would allow write skew/orphans.
              const locked = await events.updateOne({ _id: eventId }, { $inc: { participationVersion: 1 } }, { session });
              if (!locked.acknowledged) throw unavailable(true);
              if (locked.matchedCount !== 1) throw missing();
              const existing = await participants.findOne({ eventId, userId }, { session, hint: index.name, projection: { _id: 1, eventId: 1, joinedAt: 1 } });
              if (existing) return { created: false, participation: participationDto(existing) };
              const time = now();
              if (!(time instanceof Date) || !Number.isFinite(+time)) throw unavailable(true);
              const row = { _id: new ObjectId(), eventId, userId, joinedAt: new Date(+time) };
              const inserted = await participants.insertOne(row, { session });
              if (!inserted.acknowledged) throw unavailable(true);
              return { created: true, participation: participationDto(row) };
            });
          } catch (error) {
            if (error.code !== 11000 || attempt !== 0) throw error;
          }
        }
      } catch (error) {
        if (error instanceof EventDataError && error.code === 'EVENT_NOT_FOUND') throw error;
        throw unavailable(true);
      }
    },
  });
}
