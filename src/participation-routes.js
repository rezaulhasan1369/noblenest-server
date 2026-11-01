import { Router } from 'express';
import { EventDataError, eventPagination, parseEventId } from './event-model.js';

export function createParticipationRouter(repository, authenticate) {
  const router = Router();
  const noStore = (_req, res, next) => { res.set('Cache-Control', 'no-store'); next(); };
  function handler(join) {
    return async (req, res) => {
      const options = { page: 1, pageSize: 12 }, seen = new Set();
      try {
        for (const [key, value] of new URLSearchParams(req.originalUrl.split('?').slice(1).join('?'))) {
          if (join || !Object.hasOwn(options, key) || seen.has(key) || !/^[1-9][0-9]{0,3}$/.test(value)) throw Error();
          seen.add(key); options[key] = Number(value);
        }
        eventPagination(options);
      } catch { return res.status(400).json({ error: 'Invalid event query.' }); }
      if (join) {
        try { parseEventId(req.params.id); }
        catch { return res.status(400).json({ error: 'Invalid event identifier.' }); }
      }
      const hasBody = !!req.headers['transfer-encoding'] || Number(req.headers['content-length'] || 0) > 0;
      const type = (req.get('content-type') || '').split(';')[0].trim().toLowerCase();
      if ((hasBody || type) && type !== 'application/json') return res.status(415).json({ error: 'Unsupported content type' });
      if (hasBody) return res.status(400).json({ error: 'Request body is not allowed.' });
      if (!repository) return res.status(503).json({ error: 'Participation data is temporarily unavailable.' });
      try {
        if (join) {
          const result = await repository.joinEvent(req.auth, req.params.id);
          return res.status(result.created ? 201 : 200).json({ participation: result.participation });
        }
        return res.json({ events: await repository.listJoinedEvents(req.auth, options), pagination: options });
      } catch (error) {
        if (error instanceof EventDataError && error.code === 'AUTH_REQUIRED') return res.status(401).json({ error: 'Authentication required' });
        if (error instanceof EventDataError && error.code === 'EVENT_NOT_FOUND') return res.status(404).json({ error: 'Event not found.' });
        return res.status(503).json({ error: 'Participation data is temporarily unavailable.' });
      }
    };
  }
  router.get('/joined', noStore, authenticate, handler(false));
  router.post('/:id/join', noStore, authenticate, handler(true));
  return router;
}
