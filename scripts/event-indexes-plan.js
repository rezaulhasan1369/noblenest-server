import { EVENT_COLLECTION_NAME, EVENT_INDEXES } from '../src/event-repository.js';

// Deliberately no environment loading, MongoClient or apply mode. Applying the
// repository's initializeIndexes() requires a separate owner-approved operation.
if (process.argv.length !== 2) {
  console.error('Plan only: no arguments or index execution are supported.');
  process.exitCode = 1;
} else {
  console.info(JSON.stringify({ collection: EVENT_COLLECTION_NAME, indexes: EVENT_INDEXES, builtIn: '_id_', execution: 'Not performed; separate owner approval required.' }, null, 2));
}
