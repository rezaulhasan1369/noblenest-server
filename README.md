# NobleNest server — Phase D0

Node 24, npm, JavaScript ES modules. Run `npm ci`, copy `.env.example` to `.env`,
then `npm run dev`. Local API: http://localhost:5000/api/health.

Commands: `npm run check`, `npm test`, `npm start`, `npm run check:db`.
Health returns only `{ "status": "ok" }`; it is liveness, not database readiness.
Database readiness is an operator-only CLI command with a bounded connection/ping,
generic output and nonzero exit on failure. Run it in the deployed service shell
after securely supplying Atlas credentials. There is no public readiness endpoint.
Health does not need a database connection; event reads use MongoDB lazily.

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

## Deployment verification

Production MongoDB connectivity previously passed. GitHub-triggered deployment
remains unverified. After an approved push to `main`, confirm Render automatically
deploys the pushed commit and `/api/health` returns HTTP 200. Record the deployment
trigger and commit SHA before considering a manual deployment.

## Public event retrieval (D3.2)

These GET endpoints remain read-only and unauthenticated. Authenticated writes are
described below; no joining route exists. Authorization policies and authentication collections are unchanged.
Run `npm run check`, `npm run check:events` and `npm test` before review.

| Endpoint | Query | HTTP 200 envelope |
| --- | --- | --- |
| `GET /api/events` | Optional `page`, decimal integer 1-1000, default 1 | `{ "events": [], "pagination": { "page": 1, "pageSize": 6 } }` |
| `GET /api/events/upcoming` | None | `{ "events": [] }` |
| `GET /api/events/:id` | None; ID is exactly 24 hexadecimal characters | `{ "event": { ... } }` |

Both lists select `eventDate > server UTC now`, ascending `eventDate` then `_id`.
The D3.1 repository fixes every page to six items (maximum skip 5994). The homepage
always calls `listUpcomingEvents()` without arguments. No page size, arbitrary
sort, offset, filters, duplicate keys, nested parameters, leading-zero numbers,
decimals or unknown query keys are accepted. Empty lists and pages beyond the data
return HTTP 200 with `events: []`. There is no total count or snapshot guarantee:
time passing or concurrent changes can shift page boundaries. HTTP HEAD follows
Express GET semantics and OPTIONS retains the existing CORS policy.

Event DTO shape (illustration only; no database record is created):

```json
{
  "event": {
    "id": "000000000000000000000001",
    "title": "Example community activity",
    "description": "Illustrative response shape only.",
    "eventType": "Cleanup",
    "thumbnailUrl": "https://example.invalid/image.webp",
    "thumbnailAlt": "Community activity",
    "location": "Example location",
    "eventDate": "2030-02-01T09:00:00.000Z",
    "creatorId": "verified-user-id",
    "createdAt": "2030-01-01T00:00:00.000Z",
    "updatedAt": "2030-01-01T00:00:00.000Z"
  }
}
```

Event errors use `{ "error": "fixed message" }`: 400 `Invalid event query.` or
`Invalid event identifier.`, 404 `Event not found.`, and 503
`Event data is temporarily unavailable.`. Existing global errors still apply to
CORS, malformed path encoding, body parsing and unmatched routes. Neither raw
driver errors, credentials nor stack traces are returned or logged. All matched
event responses use `Cache-Control: no-store`. DTOs expose only the D3.1 allowlist;
creator IDs are public under that approved contract, never session data or emails.

### MongoDB operations and indexes

The configured database must be NobleNest (`MONGODB_DB_NAME` case-insensitively
matches `noblenest`; the exact configured spelling is passed to MongoDB). Only
`nn_events` is selected by the event store. One lazy MongoClient per runtime is
reused across requests, separate from the unchanged authorization client. Maximum
pool size is five, pool wait/selection/connect timeouts are five seconds, and
operation/socket timeouts are ten seconds. Health remains liveness during a
database outage. Development without both MongoDB variables returns event 503s;
production still requires database configuration. Shutdown drains HTTP first,
closes both clients even if one fails, and retains the ten-second shutdown deadline.

`npm run events:indexes:plan` is offline: it loads no environment file, connects
nowhere and prints only the approved `nn_events` index specifications:

- `events_upcoming_date_id`: `{ eventDate: 1, _id: 1 }`
- `events_creator_date_id`: `{ creatorId: 1, eventDate: 1, _id: 1 }`
- MongoDB's built-in unique `_id_` index handles ID lookup.

There is intentionally no apply flag or automatic initialization. The unchanged
D3.1 `repository.initializeIndexes()` remains the explicit mechanism for a future
separately owner-approved operator operation against a verified target. It is
never called by startup, reads or a public route. Do not repurpose a test NODE_ENV
as permission to run against Atlas. Existing index contract tests use an isolated
collection double; they do not prove live Atlas index presence or query plans.
Conflicting existing index definitions require operator review; never drop or
rebuild indexes automatically. A missing index can affect performance, not the
fixed sort and filtering contract.

## Authenticated event writes (D3.3)

All writes require `Authorization: Bearer <JWT>` verified by the existing issuer,
audience, EdDSA signature, expiration, scope and active-session checks. Cookies,
query parameters, custom headers and body fields cannot supply creator identity.
The repository receives only verified `req.auth` and derives `creatorId` from its
subject. No JWT/session policy, ownership filter or authentication collection changed.

| Endpoint | Request | Success |
| --- | --- | --- |
| `POST /api/events` | Required writable fields as an `application/json` object | 201 `{ "event": { ...approved DTO... } }`, relative `Location: /api/events/:id` |
| `PATCH /api/events/:id` | Nonempty subset of writable fields as an `application/json` object | 200 `{ "event": { ...approved DTO... } }` |
| `DELETE /api/events/:id` | No body | 204, empty body |

Required create fields: `title`, `description`, `eventType`, `thumbnailUrl`,
`location`, `eventDate`. `thumbnailAlt` is optional. PATCH accepts the same fields;
omitted fields are preserved. D3.1 validation remains authoritative: trimmed
nonempty strings, title <=200, description <=5000, location <=300, URL <=2048,
alt text <=300; categories exactly `Cleanup`, `Plantation`, `Donation` or
`Community service`; date is a strictly future canonical UTC ISO timestamp with
milliseconds; thumbnail uses HTTPS without embedded credentials. The server does
not fetch image URLs. Unknown/immutable fields (including `_id`, `id`, `creatorId`,
`userId`, email, `createdAt` and `updatedAt`) and MongoDB operators are rejected.
The server alone sets creation/update timestamps. The DTO is unchanged from above.

Write endpoints accept no query parameters. IDs must be 24 hexadecimal characters.
POST/PATCH require JSON, not forms, multipart, text or vendor JSON types. DELETE
rejects a body; omit its Content-Type header when sending no body. Existing JSON
parsing and the 16 KiB limit apply before route authentication, so malformed JSON
or oversized requests can receive 400/413 even without a token. Otherwise the
write route authenticates before query, identifier and payload handling.

Errors use `{ "error": "fixed message" }`: 401 `Authentication required`,
400 `Invalid event query.`, `Invalid event identifier.` or `Invalid event data.`,
415 `Unsupported content type`, and 503 `Event data is temporarily unavailable.`.
Missing authentication configuration retains the existing 503
`Authentication is not configured` response. Global CORS/body-parser errors retain
their existing sanitized responses. Both absent and non-owned records return
exactly 404 `{ "error": "Event not found." }`; ownership is never disclosed.

PATCH and DELETE perform the unchanged atomic MongoDB operation with both `_id`
and verified `creatorId` in the filter; there is no preceding ownership read.
All event responses are non-cacheable. The same exact CORS origins are required;
event-path preflights now advertise POST/PATCH/DELETE in addition to GET/HEAD/OPTIONS.
Other paths keep their existing method policy, credentials remain disabled, and
PUT/join routes are absent. CORS is not a substitute for JWT authorization.

Writes reuse the existing `nn_events` repository and pooled client. There is no
index execution or new environment variable. Tests use signed fixture JWTs and
isolated BSON-aware collection doubles only. Live Atlas writes and deployments
are deliberately untested; no records have been inserted into a real database.
