import { createApp } from './app.js';
import { readConfig } from './config.js';

try {
  const config = readConfig();
  const server = createApp(config).listen(config.port, '0.0.0.0', () => {
    console.info('NobleNest API listening');
  });
  server.on('error', () => { console.error('API startup failed'); process.exitCode = 1; });
  let shuttingDown = false;
  function shutdown() {
    if (shuttingDown) return;
    shuttingDown = true;
    const deadline = setTimeout(() => process.exit(1), 10000);
    deadline.unref();
    server.close(error => {
      clearTimeout(deadline);
      process.exitCode = error ? 1 : 0;
    });
    server.closeIdleConnections();
  }
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
} catch {
  console.error('Invalid server environment; check the documented configuration');
  process.exitCode = 1;
}
