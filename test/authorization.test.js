import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPair, SignJWT } from 'jose';
import { createTokenVerifier, readAuthConfig, bearerAuthorization, requireOwnership, trustedCreatorEmail } from '../src/authorization.js';
import { createApp } from '../src/app.js';

const config = { issuer: 'http://127.0.0.1:3000', audience: 'http://127.0.0.1:5001' };
test('creator email comes only from matching active session and account records', async () => {
  const auth = { subject: 'owner', sessionId: 'active', scopes: ['noblenest:events'], email: 'forged@example.invalid' };
  const calls = [];
  let session = { _id: 'active' }, account = { email: ' Owner@Example.Invalid ' };
  const database = { collection(name) { return { async findOne(filter, options) { calls.push({ name, filter, options }); return name === 'nn_auth_session' ? session : account; } }; } };
  assert.equal(await trustedCreatorEmail(database, auth), 'owner@example.invalid');
  assert.equal(calls[0].filter.userId, 'owner'); assert.equal(calls[0].filter._id, 'active'); assert(calls[0].filter.expiresAt.$gt instanceof Date);
  assert.deepEqual(calls[1], { name: 'nn_auth_user', filter: { _id: 'owner' }, options: { projection: { email: 1 } } });
  session = null; calls.length = 0; await assert.rejects(trustedCreatorEmail(database, auth)); assert.equal(calls.length, 1);
  session = { _id: 'active' };
  for (const value of [null, { email: '' }, { email: 'invalid' }]) { account = value; await assert.rejects(trustedCreatorEmail(database, auth)); }
  calls.length = 0; await assert.rejects(trustedCreatorEmail(database, { subject: 'owner' })); assert.equal(calls.length, 0);
});
test('authentication configuration fails closed and requires explicit trusted URLs', () => {
  assert.equal(readAuthConfig({}), null);
  for (const env of [{ AUTH_JWT_ISSUER: config.issuer }, { NODE_ENV: 'production', AUTH_JWT_ISSUER: config.issuer, AUTH_JWT_AUDIENCE: config.audience, AUTH_JWKS_URL: config.issuer + '/api/auth/jwks' }, { AUTH_JWT_ISSUER: config.issuer, AUTH_JWT_AUDIENCE: config.audience, AUTH_JWKS_URL: 'https://attacker.invalid/jwks' }]) assert.throws(() => readAuthConfig(env));
});
test('JWT rejects forged, expired, malformed, wrong issuer/audience/scope/subject and revoked sessions', async () => {
  const key = await generateKeyPair('EdDSA'), forged = await generateKeyPair('EdDSA');
  const verify = createTokenVerifier(config, key.publicKey, async (sid, sub) => sid === 'active' && sub === 'owner');
  async function token(patch = {}, signingKey = key.privateKey) {
    return new SignJWT({ sid: 'active', scope: 'noblenest:events', ...patch }).setProtectedHeader({ alg: 'EdDSA' }).setIssuer(config.issuer).setAudience(config.audience).setSubject('owner').setIssuedAt().setExpirationTime('5m').sign(signingKey);
  }
  assert.equal((await verify(await token())).subject, 'owner');
  for (const value of ['malformed', await token({}, forged.privateKey), await token({ sid: 'revoked' }), await token({ scope: 'other' })]) await assert.rejects(verify(value));
  for (const claims of [{ iss: 'https://attacker.invalid' }, { aud: 'wrong' }, { sub: '' }, { exp: 1 }, { iat: 1 }, { sid: null }]) {
    const jwt = await new SignJWT({ iss: config.issuer, aud: config.audience, sub: 'owner', sid: 'active', scope: 'noblenest:events', iat: Math.floor(Date.now()/1000), exp: Math.floor(Date.now()/1000)+300, ...claims }).setProtectedHeader({ alg: 'EdDSA' }).sign(key.privateKey);
    await assert.rejects(verify(jwt));
  }
});
test('HTTP authorization ignores browser-supplied identity and safely rejects invalid credentials', async t => {
  const app = createApp({ origins: ['http://127.0.0.1:3000'] }, { middleware: bearerAuthorization(async () => { throw Error('private driver details'); }) });
  const server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve)); t.after(() => new Promise(resolve => server.close(resolve)));
  for (const headers of [{}, { authorization: 'Bearer forged', 'x-user-id': 'owner' }, { authorization: 'Basic credentials' }]) {
    const result = await fetch(`http://127.0.0.1:${server.address().port}/api/authz/me?userId=owner`, { headers });
    assert.equal(result.status, 401); assert.deepEqual(await result.json(), { error: 'Authentication required' });
  }
});
test('ownership requires verified identity and stored creator', async () => {
  const guard = requireOwnership(async () => 'owner');
  const check = async auth => { let status = 200, called = false; const res = { status(value) { status = value; return this; }, json() {} }; await guard({ auth, params: { id: 'event' } }, res, () => called = true); return { status, called }; };
  assert.deepEqual(await check(null), { status: 401, called: false });
  assert.deepEqual(await check({ subject: 'other' }), { status: 403, called: false });
  assert.deepEqual(await check({ subject: 'owner' }), { status: 200, called: true });
});
