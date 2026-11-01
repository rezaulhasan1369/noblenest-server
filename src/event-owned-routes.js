import { Router } from 'express';
import { EventDataError, eventPagination } from './event-model.js';

function ownedPagination(req) {
  const query = new URLSearchParams(req.originalUrl.split('?').slice(1).join('?'));
  const seen = new Set(), options = { page: 1, pageSize: 12 };
  for (const [key, value] of query) {
    if (!Object.hasOwn(options, key) || seen.has(key) || !/^[1-9][0-9]{0,3}$/.test(value)) throw Error();
    seen.add(key);
    options[key] = Number(value);
  }
  // Reuse the authoritative D3.1 bounds before any repository operation.
  eventPagination(options);
  return options;
}

export function createOwnedEventRouter(repository, authenticate) {
  const router = Router();
  router.get('/mine', (_req, res, next) => {
    res.set('Cache-Control', 'no-store'); next();
  }, authenticate, async (req, res) => {
    let pagination;
    try { pagination = ownedPagination(req); }
    catch { return res.status(400).json({ error: 'Invalid event query.' }); }
    if (!repository) return res.status(503).json({ error: 'Event data is temporarily unavailable.' });
    try {
      // Never derive an owner from cookies, headers, bodies or query strings.
      // The repository enforces creatorId in MongoDB's find filter itself.
      const events = await repository.listEventsByCreator(req.auth, pagination);
      res.json({ events, pagination });
    } catch (error) {
      if (error instanceof EventDataError && error.code === 'AUTH_REQUIRED') {
        return res.status(401).json({ error: 'Authentication required' });
      }
      res.status(503).json({ error: 'Event data is temporarily unavailable.' });
    }
  });
  return router;
}
