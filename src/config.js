export function readConfig(env = process.env) {
  const nodeEnv = env.NODE_ENV || 'development';
  if (!['development', 'test', 'production'].includes(nodeEnv)) throw new Error('Invalid NODE_ENV');
  const port = Number(env.PORT || 5000);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid PORT');
  const origins = (env.CLIENT_ORIGIN || '').split(',').map(value => value.trim());
  if (origins.some(origin => {
    try {
      const url = new URL(origin);
      return url.origin !== origin || !['http:', 'https:'].includes(url.protocol) ||
        (nodeEnv === 'production' && url.protocol !== 'https:');
    } catch { return true; }
  })) throw new Error('CLIENT_ORIGIN must contain explicit origins (HTTPS in production)');
  const mongoUri = env.MONGODB_URI || '';
  const dbName = env.MONGODB_DB_NAME || '';
  if (Boolean(mongoUri) !== Boolean(dbName)) throw new Error('Configure both MongoDB variables');
  if (mongoUri && !/^mongodb(?:\+srv)?:\/\//.test(mongoUri)) throw new Error('Invalid MONGODB_URI');
  if (dbName && /[\s/\\."$\x00]/.test(dbName)) throw new Error('Invalid MONGODB_DB_NAME');
  if (nodeEnv === 'production' && !mongoUri) throw new Error('MongoDB configuration required in production');
  return { nodeEnv, port, origins, mongoUri, dbName };
}
