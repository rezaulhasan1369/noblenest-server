import { MongoClient } from 'mongodb';
import { createEventRepository, EVENT_COLLECTION_NAME } from './event-repository.js';

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
  const repository = createEventRepository(client.db(config.dbName).collection(EVENT_COLLECTION_NAME));
  let closing;
  return Object.freeze({
    repository,
    close() { return closing ??= Promise.resolve().then(() => client.close()); },
  });
}
