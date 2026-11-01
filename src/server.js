import { readConfig } from './config.js';
import { createRuntime } from './runtime.js';

try {
  const config = readConfig();
  const runtime = await createRuntime(config);
  const server = runtime.app.listen(config.port, '0.0.0.0', error => {
    if (!error) console.info('NobleNest API listening');
  });
  server.on('error', () => { console.error('API startup failed'); shutdown(true); });
  let shuttingDown = false;
  function shutdown(failed = false) {
    if (shuttingDown) return;
    shuttingDown = true;
    const deadline = setTimeout(() => process.exit(1), 10000);
    deadline.unref();
    server.close(async error => {
      process.exitCode = error || failed ? 1 : 0;
      try { await runtime.close(); } catch { process.exitCode = 1; }
      clearTimeout(deadline);
    });
    server.closeIdleConnections();
  }
  process.on('SIGTERM', () => shutdown());
  process.on('SIGINT', () => shutdown());
} catch {
  console.error('Invalid server environment; check the documented configuration');
  process.exitCode = 1;
}
