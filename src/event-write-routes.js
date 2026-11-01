import { Router } from 'express';
import { EventDataError, parseEventId } from './event-model.js';

export function createEventWriteRouter(repository, authenticate) {
  const router = Router();
  function write(operation, { detail = false, body = true } = {}) {
    return async (req, res) => {
      const query = new URLSearchParams(req.originalUrl.split('?').slice(1).join('?'));
      if ([...query].length) return res.status(400).json({ error: 'Invalid event query.' });
      if (detail) {
        try { parseEventId(req.params.id); }
        catch { return res.status(400).json({ error: 'Invalid event identifier.' }); }
      }
      const hasBody = Boolean(req.headers['transfer-encoding']) || Number(req.headers['content-length'] || 0) > 0;
      const contentType = (req.get('content-type') || '').split(';')[0].trim().toLowerCase();
      if ((body || hasBody || contentType) && contentType !== 'application/json') {
        return res.status(415).json({ error: 'Unsupported content type' });
      }
      if (!body && hasBody) return res.status(400).json({ error: 'Invalid event data.' });
      if (!repository) return res.status(503).json({ error: 'Event data is temporarily unavailable.' });
      try { await operation(req, res); }
      catch (error) {
        // Only trusted model error codes receive a client-error status. Never
        // reflect driver errors, status properties, raw messages or causes.
        if (error instanceof EventDataError && error.code === 'INVALID_EVENT_DATA') {
          return res.status(400).json({ error: 'Invalid event data.' });
        }
        if (error instanceof EventDataError && error.code === 'AUTH_REQUIRED') {
          return res.status(401).json({ error: 'Authentication required' });
        }
        return res.status(503).json({ error: 'Event data is temporarily unavailable.' });
      }
    };
  }
  router.post('/', authenticate, write(async (req, res) => {
    // The repository validates the original payload with validateEventInput().
    // Identity comes exclusively from the existing verified JWT middleware.
    const event = await repository.createEvent(req.auth, req.body);
    res.location(`/api/events/${event.id}`).status(201).json({ event });
  }));
  router.patch('/:id', authenticate, write(async (req, res) => {
    const event = await repository.updateOwnedEvent(req.auth, req.params.id, req.body);
    if (!event) return res.status(404).json({ error: 'Event not found.' });
    res.json({ event });
  }, { detail: true }));
  router.delete('/:id', authenticate, write(async (req, res) => {
    const deleted = await repository.deleteOwnedEvent(req.auth, req.params.id);
    if (!deleted) return res.status(404).json({ error: 'Event not found.' });
    res.status(204).end();
  }, { detail: true, body: false }));
  return router;
}
