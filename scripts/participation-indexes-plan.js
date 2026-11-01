import { PARTICIPATION_COLLECTION_NAME, PARTICIPATION_INDEXES } from '../src/participation-repository.js';

// Offline plan only: no environment loading, MongoClient or index apply mode.
if (process.argv.length !== 2) {
  console.error('Plan only: no arguments or index execution are supported.');
  process.exitCode = 1;
} else {
  console.info(JSON.stringify({ collection: PARTICIPATION_COLLECTION_NAME, indexes: PARTICIPATION_INDEXES,
    prerequisite: 'Join writes require a confirmed full unique eventId/userId index. No index is created here.',
    execution: 'Not performed; separate owner approval required.' }, null, 2));
}
