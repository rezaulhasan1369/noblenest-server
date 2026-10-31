# NobleNest server — Phase D0

Node 24, npm, JavaScript ES modules. Run `npm ci`, copy `.env.example` to `.env`,
then `npm run dev`. Local API: http://localhost:5000/api/health.

Commands: `npm run check`, `npm test`, `npm start`, `npm run check:db`.
Health returns only `{ "status": "ok" }`; it is liveness, not database readiness.
Database readiness is an operator-only CLI command with a bounded connection/ping,
generic output and nonzero exit on failure. Run it in the deployed service shell
after securely supplying Atlas credentials. There is no public readiness endpoint.
The API itself does not need a database connection during D0.

`CLIENT_ORIGIN` is a comma-separated list of exact origins without trailing slashes.
Use `http://localhost:3000` locally; remote production origins must use HTTPS.
Production startup requires both MongoDB variables. Development allows both empty.
Render supplies `PORT`; the server binds to `0.0.0.0` and closes on SIGTERM/SIGINT.
Body limit is 16 KiB. CORS is a browser control, not authentication.

After owner approval, import this independent repository into Render as a Node web
service, root `.`, build `npm ci`, start `npm start`, health path `/api/health`.
`render.yaml` describes the same configuration; review plan/pricing in the dashboard.
Node is pinned through `.node-version` and package engines. Set `NODE_ENV=production`,
the approved HTTPS frontend origin, and both MongoDB variables in provider settings.
Never put real secrets in YAML, source, commits or screenshots.

Atlas needs an application database user with least privilege on the selected database
and network access for the deployed service's actual outbound addresses. Configure
these only with owner approval; do not default to unrestricted network access.

Recheck health, the frontend browser button, allowed/rejected CORS origins, and
`npm run check:db` after deployment and an authorized GitHub push/redeploy.
