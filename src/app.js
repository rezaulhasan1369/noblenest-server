import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import { createEventRouter } from './event-routes.js';
import { createEventWriteRouter } from './event-write-routes.js';
import { createOwnedEventRouter } from './event-owned-routes.js';

export function createApp(config, authorization, eventRepository) {
  const app = express();
  app.disable('x-powered-by');
  app.use(helmet());
  app.use(cors((req, callback) => callback(null, {
    origin(origin, callback) {
      if (!origin || config.origins.includes(origin)) return callback(null, true);
      const error = new Error('Origin not allowed');
      error.status = 403;
      callback(error);
    },
    methods: req.path === '/api/events' || req.path.startsWith('/api/events/')
      ? ['GET', 'HEAD', 'OPTIONS', 'POST', 'PATCH', 'DELETE']
      : ['GET', 'HEAD', 'OPTIONS'],
    credentials: false,
  })));
  app.use(express.json({ limit: '16kb' }));
  app.use(express.urlencoded({ extended: false, limit: '16kb' }));
  app.get('/api/health', (_req, res) => {
    res.set('Cache-Control', 'no-store').json({ status: 'ok' });
  });
  const authenticate = authorization?.middleware || ((_req, res) => res.status(503).json({ error: 'Authentication is not configured' }));
  app.get('/api/authz/me', authenticate, (req, res) => res.json({ subject: req.auth.subject, scopes: req.auth.scopes }));
  // Static authenticated /mine must resolve before the public /:id handler.
  app.use('/api/events', createOwnedEventRouter(eventRepository, authenticate));
  app.use('/api/events', createEventRouter(eventRepository));
  app.use('/api/events', createEventWriteRouter(eventRepository, authenticate));
  app.use((_req, res) => res.status(404).json({ error: 'Not found' }));
  // Do not return or log driver errors, request bodies, or configuration values.
  app.use((error, _req, res, _next) => {
    const status = [400, 403, 413, 415].includes(error.status) ? error.status : 500;
    const messages = { 400: 'Invalid request', 403: 'Origin not allowed', 413: 'Request too large', 415: 'Unsupported content type' };
    res.status(status).json({ error: messages[status] || 'Internal server error' });
  });
  return app;
}
