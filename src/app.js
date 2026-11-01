import express from 'express';
import cors from 'cors';
import helmet from 'helmet';

export function createApp(config, authorization) {
  const app = express();
  app.disable('x-powered-by');
  app.use(helmet());
  app.use(cors({
    origin(origin, callback) {
      if (!origin || config.origins.includes(origin)) return callback(null, true);
      const error = new Error('Origin not allowed');
      error.status = 403;
      callback(error);
    },
    methods: ['GET', 'HEAD', 'OPTIONS'],
    credentials: false,
  }));
  app.use(express.json({ limit: '16kb' }));
  app.use(express.urlencoded({ extended: false, limit: '16kb' }));
  app.get('/api/health', (_req, res) => {
    res.set('Cache-Control', 'no-store').json({ status: 'ok' });
  });
  app.get('/api/authz/me', authorization?.middleware || ((_req, res) => res.status(503).json({ error: 'Authentication is not configured' })), (req, res) => res.json({ subject: req.auth.subject, scopes: req.auth.scopes }));
  app.use((_req, res) => res.status(404).json({ error: 'Not found' }));
  // Do not return or log driver errors, request bodies, or configuration values.
  app.use((error, _req, res, _next) => {
    const status = [400, 403, 413, 415].includes(error.status) ? error.status : 500;
    const messages = { 400: 'Invalid request', 403: 'Origin not allowed', 413: 'Request too large', 415: 'Unsupported content type' };
    res.status(status).json({ error: messages[status] || 'Internal server error' });
  });
  return app;
}
