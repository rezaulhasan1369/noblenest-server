import { MongoClient } from 'mongodb';
import { readConfig } from '../src/config.js';

// Operator-only readiness check: no public endpoint or diagnostic credentials.
let client;
try {
  const config = readConfig();
  if (!config.mongoUri) throw new Error('Missing database configuration');
  client = new MongoClient(config.mongoUri, { serverSelectionTimeoutMS: 5000, connectTimeoutMS: 5000, socketTimeoutMS: 5000 });
  await client.connect();
  await client.db(config.dbName).command({ ping: 1 }, { timeoutMS: 5000 });
  console.info('Database ready');
} catch {
  console.error('Database readiness failed; verify configuration and network access');
  process.exitCode = 1;
} finally {
  await client?.close();
}
