import { MongoClient } from 'mongodb';
import { createEventRepository, EVENT_COLLECTION_NAME } from './event-repository.js';
import { createParticipationRepository, PARTICIPATION_COLLECTION_NAME } from './participation-repository.js';
import { createEventLifecycle } from './event-lifecycle.js';

export function createEventStore(config, { Client = MongoClient } = {}) {
  if (!config.mongoUri && !config.dbName && config.nodeEnv !== 'production') {
    return { repository: undefined, close: async () => {} };
  }
  if (!config.mongoUri || config.dbName?.toLowerCase() !== 'noblenest') {
    throw new Error('NobleNest event database configuration required.');
  }
  const client = new Client(config.mongoUri, {
    maxPoolSize: 5, minPoolSize: 0, serverSelectionTimeoutMS: 5000,
    connectTimeoutMS: 5000, socketTimeoutMS: 10000, waitQueueTimeoutMS: 5000,
    timeoutMS: 10000,
  });
  // The driver connects lazily on the first read, then reuses this client pool.
  // No ping, inserts, collection creation or index initialization at startup.
  const database = client.db(config.dbName), events = database.collection(EVENT_COLLECTION_NAME);
  const participants = database.collection(PARTICIPATION_COLLECTION_NAME);
  const lifecycle = createEventLifecycle(client, events, participants);
  // Low-level repositories retain read/validation contracts; all runtime join
  // and delete routes use the transaction-coordinated lifecycle operations.
  const repository = Object.freeze({ ...createEventRepository(events), deleteOwnedEvent: lifecycle.deleteOwnedEvent });
  const participationRepository = Object.freeze({ ...createParticipationRepository(participants, events), joinEvent: lifecycle.joinEvent });
  let closing;
  return Object.freeze({
    repository,
    participationRepository,
    close() { return closing ??= Promise.resolve().then(() => client.close()); },
  });
}
