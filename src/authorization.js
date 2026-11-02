import { createRemoteJWKSet, jwtVerify } from 'jose';
import { MongoClient } from 'mongodb';
import { normalizedCreatorEmail, verifiedCreatorId } from './event-model.js';

export async function trustedCreatorEmail(database, auth) {
  const userId = verifiedCreatorId(auth);
  const session = await database.collection('nn_auth_session').findOne({ _id: auth.sessionId, userId, expiresAt: { $gt: new Date() } }, { projection: { _id: 1 } });
  if (!session) throw Error('Creator session unavailable');
  const user = await database.collection('nn_auth_user').findOne({ _id: userId }, { projection: { email: 1 } });
  return normalizedCreatorEmail(user?.email);
}

export function readAuthConfig(env = process.env) {
  const values = [env.AUTH_JWT_ISSUER, env.AUTH_JWT_AUDIENCE, env.AUTH_JWKS_URL];
  if (values.every(value => !value)) return null;
  if (values.some(value => !value)) throw Error('Configure all API authentication variables');
  for (const value of values) {
    const url = new URL(value);
    if (url.username || url.password || url.hash || url.search || (url.protocol !== 'https:' && !(env.NODE_ENV !== 'production' && url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname)))) throw Error('Invalid API authentication URL');
  }
  if (new URL(values[0]).origin !== values[0] || new URL(values[1]).origin !== values[1] || values[2] !== values[0] + '/api/auth/jwks') throw Error('Invalid API authentication origins');
  return { issuer: values[0], audience: values[1], jwksUrl: values[2] };
}
export function createTokenVerifier(config, key, isActiveSession) {
  return async token => {
    const { payload } = await jwtVerify(token, key, { issuer: config.issuer, audience: config.audience, algorithms: ['EdDSA'], requiredClaims: ['exp', 'iat', 'sub', 'sid', 'scope'], maxTokenAge: '5m', clockTolerance: 5 });
    if (typeof payload.sub !== 'string' || !payload.sub || payload.sub.length > 128 || typeof payload.sid !== 'string' || !payload.sid || payload.sid.length > 128 || typeof payload.scope !== 'string' || !payload.scope.split(' ').includes('noblenest:events')) throw Error('Invalid authorization claims');
    if (!await isActiveSession(payload.sid, payload.sub)) throw Error('Session is no longer active');
    return Object.freeze({ subject: payload.sub, sessionId: payload.sid, scopes: Object.freeze(payload.scope.split(' ')) });
  };
}
export function bearerAuthorization(verify) {
  return async (req, res, next) => {
    res.set('Cache-Control', 'no-store');
    const header = req.get('authorization') || '';
    if (!/^Bearer [A-Za-z0-9_.-]{1,8192}$/.test(header)) return res.status(401).json({ error: 'Authentication required' });
    try { req.auth = await verify(header.slice(7)); next(); }
    catch { res.status(401).json({ error: 'Authentication required' }); }
  };
}
export function requireOwnership(loadOwner) {
  return async (req, res, next) => {
    if (!req.auth) return res.status(401).json({ error: 'Authentication required' });
    try {
      const ownerId = await loadOwner(req.params.id);
      if (!ownerId) return res.status(404).json({ error: 'Not found' });
      if (ownerId !== req.auth.subject) return res.status(403).json({ error: 'Not permitted' });
      next();
    } catch { res.status(503).json({ error: 'Authorization unavailable' }); }
  };
}
export function createAuthorization(config, authConfig = readAuthConfig()) {
  if (!authConfig) return { middleware: (_req, res) => res.status(503).json({ error: 'Authentication is not configured' }), close: async () => {} };
  if (config.dbName?.toLowerCase() !== 'noblenest' || !config.mongoUri) throw Error('NobleNest authentication database required');
  const client = new MongoClient(config.mongoUri, { maxPoolSize: 5, serverSelectionTimeoutMS: 5000, connectTimeoutMS: 5000, socketTimeoutMS: 10000 });
  const key = createRemoteJWKSet(new URL(authConfig.jwksUrl), { timeoutDuration: 5000 });
  const verify = createTokenVerifier(authConfig, key, async (sid, sub) => Boolean(await client.db(config.dbName).collection('nn_auth_session').findOne({ _id: sid, userId: sub, expiresAt: { $gt: new Date() } }, { projection: { _id: 1 } })));
  return { middleware: bearerAuthorization(verify), creatorEmail: auth => trustedCreatorEmail(client.db(config.dbName), auth), close: () => client.close() };
}
