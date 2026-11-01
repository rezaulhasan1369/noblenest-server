import { Router } from 'express';
import { eventPagination, HOMEPAGE_EVENT_LIMIT, parseEventId } from './event-model.js';

const unavailable = res => res.status(503).json({ error: 'Event data is temporarily unavailable.' });

// Parse the raw query so duplicate keys cannot disappear in Express's parser.
function queryPage(req, paginated) {
  const query = new URLSearchParams(req.originalUrl.split('?').slice(1).join('?'));
  const entries = [...query];
  if (!paginated && entries.length) throw Error();
  if (entries.some(([key]) => key !== 'page') || entries.length > 1) throw Error();
  const value = query.get('page');
  if (value !== null && !/^[1-9][0-9]{0,3}$/.test(value)) throw Error();
  const page = value === null ? 1 : Number(value);
  eventPagination({ page }, { upcoming: true });
  return page;
}

export function createEventRouter(repository) {
  const router = Router();
  router.use((_req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
  function read(handler, { paginated = false, detail = false } = {}) {
    return async (req, res) => {
      let page;
      try { page = queryPage(req, paginated); }
      catch { return res.status(400).json({ error: 'Invalid event query.' }); }
      if (detail) {
        try { parseEventId(req.params.id); }
        catch { return res.status(400).json({ error: 'Invalid event identifier.' }); }
      }
      // Validate requests before testing database availability. Never reflect
      // error.message, status, cause, driver metadata or configuration to HTTP.
      if (!repository) return unavailable(res);
      try { await handler(req, res, page); }
      catch { return unavailable(res); }
    };
  }
  router.get('/', read(async (_req, res, page) => {
    const events = await repository.listUpcomingEvents({ page });
    res.json({ events, pagination: { page, pageSize: HOMEPAGE_EVENT_LIMIT } });
  }, { paginated: true }));
  // This must precede /:id; the homepage cannot override its fixed six-item cap.
  router.get('/upcoming', read(async (_req, res) => {
    res.json({ events: await repository.listUpcomingEvents() });
  }));
  router.get('/:id', read(async (req, res) => {
    const event = await repository.findEventById(req.params.id);
    if (!event) return res.status(404).json({ error: 'Event not found.' });
    res.json({ event });
  }, { detail: true }));
  return router;
}
