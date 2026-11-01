import { createApp } from './app.js';
import { createAuthorization } from './authorization.js';
import { createEventStore } from './event-store.js';

// Own both independent pools; close both even if one fails. Injection keeps
// startup/shutdown tests isolated from credentials, signals and live databases.
export async function createRuntime(config, {
  eventStoreFactory = createEventStore, authorizationFactory = createAuthorization,
} = {}) {
  let events, authorization, closing;
  function close() {
    return closing ??= Promise.allSettled([events, authorization].map(resource =>
      Promise.resolve().then(() => resource?.close()),
    )).then(results => {
      if (results.some(result => result.status === 'rejected')) throw Error('Resource shutdown failed.');
    });
  }
  try {
    events = eventStoreFactory(config);
    authorization = authorizationFactory(config);
    return { app: createApp(config, authorization, events.repository, events.participationRepository), close };
  } catch {
    try { await close(); } catch { /* Preserve generic startup failure. */ }
    throw Error('Server resource initialization failed.');
  }
}
