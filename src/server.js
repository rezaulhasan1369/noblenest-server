import { createApp } from './app.js';
import { readConfig } from './config.js';
import { MongoClient } from 'mongodb';

// TEMPORARY D0 verification: remove after reviewing the production log result.
async function verifyStartupDatabase(config) {
  let client;
  try {
    client = new MongoClient(config.mongoUri, {
      serverSelectionTimeoutMS: 5000,
      connectTimeoutMS: 5000,
      socketTimeoutMS: 5000,
    });
    try {
      await client.connect();
      await client.db(config.dbName).command({ ping: 1 }, { maxTimeMS: 5000 });
    } finally {
      await client.close();
    }
    console.info('Startup database ping succeeded');
  } catch {
    console.error('Startup database ping failed');
  }
}

try {
  const config = readConfig();
  const server = createApp(config).listen(config.port, '0.0.0.0', () => {
    console.info('NobleNest API listening');
    if (config.nodeEnv === 'production') void verifyStartupDatabase(config);
  });
  server.on('error', () => { console.error('API startup failed'); process.exitCode = 1; });
  let shuttingDown = false;
  function shutdown() {
    if (shuttingDown) return;
    shuttingDown = true;
    const deadline = setTimeout(() => process.exit(1), 10000);
    deadline.unref();
    server.close(error => {
      clearTimeout(deadline);
      process.exitCode = error ? 1 : 0;
    });
    server.closeIdleConnections();
  }
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
} catch {
  console.error('Invalid server environment; check the documented configuration');
  process.exitCode = 1;
}
