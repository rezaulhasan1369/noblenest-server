# NobleNest API

Social development event CRUD, private ownership listings and participation. Client repository: https://github.com/rezaulhasan1369/noblenest-client ; server repository: https://github.com/rezaulhasan1369/noblenest-server . Official API: https://noblenest-api.onrender.com . Official website: https://noblenest-web.onrender.com . Both services are deployed on Render Free in Singapore; Vercel is retained as a frontend rollback fallback.

### Creator email (D5)

New event creation rechecks the authenticated session and loads the matching `nn_auth_user` email through the existing authorization database/client. It trims/lowercases and validates that account value, stores `creatorEmail` alongside `creatorId`, and fails closed if no valid account email is available. This is trusted account provenance, not proof of mailbox verification (email verification is intentionally not required).

Creator email is not accepted in create/update bodies, cannot be edited and is omitted from event DTOs. Ownership always uses verified creatorId. Historical events without creatorEmail remain readable/editable/deletable; no backfill or migration occurs. The authorization database user must be allowed to read matching session/account records. Lookup/driver errors remain generic 503 responses.

### Verification and operational boundaries

Unit/HTTP tests use in-memory collections and locally signed JWTs. Profile integration tests use Better Auth's memory adapter. Browser fixtures do not establish real MongoDB persistence or current deployed behavior. Run tests sequentially with `node --test --test-concurrency=1`; never point a test runner at live Atlas.

There is no distributed event API rate limiter. Per-process counters would reset and differ across instances, so shared/durable protection is deferred pending separately approved infrastructure. Existing auth-form throttles remain enabled. Token acquisition and event fetches share a bounded cancellation signal on the client, without automatic mutation retries. Participation index checks, orphan omission and non-cascading deletion policies below remain unchanged; no automatic maintenance or index creation was added.

Node 24, npm, JavaScript ES modules. Run `npm ci`, copy `.env.example` to `.env`,
then `npm run dev`. Local API: http://127.0.0.1:5000/api/health. Use port 5000 consistently, including the JWT audience on both services; override legacy port 5001 examples in copied templates.

Commands: `npm run check`, `npm test`, `npm start`, `npm run check:db`.
Health returns only `{ "status": "ok" }`; it is liveness, not database readiness.
Database readiness is an operator-only CLI command with a bounded connection/ping,
generic output and nonzero exit on failure. Run it in the deployed service shell
after securely supplying Atlas credentials. There is no public readiness endpoint.
Health does not need a database connection; event reads use MongoDB lazily.

`CLIENT_ORIGIN` is a comma-separated list of exact origins without trailing slashes.
Use `http://127.0.0.1:3000` locally, matching the client origin exactly; remote production origins must use HTTPS.
Production startup requires both MongoDB variables. Development allows both empty.
Render supplies `PORT`; the server binds to `0.0.0.0` and closes on SIGTERM/SIGINT.
Body limit is 16 KiB. CORS is a browser control, not authentication.

## Deployment and environment configuration

The existing API is deployed as noblenest-api; do not create another service as a setup step. Build: npm ci. Start: npm start. Runtime compute plan: Free. Render supplies the HTTP port. Node 24 is pinned through .node-version and package engines. Never put secrets in YAML, source, commits or screenshots.

Required environment-variable names, without credential values:

- PORT, NODE_ENV, CLIENT_ORIGIN
- MONGODB_URI, MONGODB_DB_NAME
- AUTH_JWT_ISSUER, AUTH_JWT_AUDIENCE, AUTH_JWKS_URL

Configure all three authentication URLs together. Locally, issuer is the frontend origin http://127.0.0.1:3000, audience is http://127.0.0.1:5000, and JWKS is the frontend origin followed by /api/auth/jwks. Use the same audience on the client. Both services must use the same database and exact database-name spelling.

In production, issuer is https://noblenest-web.onrender.com, audience is https://noblenest-api.onrender.com, and JWKS is the issuer followed by /api/auth/jwks. CORS includes the Render frontend and preserves both previously approved Vercel origins. JWT verification accepts one configured issuer; Vercel is a rollback fallback, not simultaneous authenticated failover.

Atlas uses the existing restricted access list, including Render Singapore ranges 74.220.52.0/24 and 74.220.60.0/24. No unrestricted Atlas rule is required. Network rules, database users and indexes require separate owner authorization to change.

Production deployments, public database-backed reads, CORS, guest authorization and JWKS checks have passed. The owner reports browser authentication acceptance at 9/9 PASS, including email/password, Google OAuth, refresh and logout. The existing local backend test result is 78/78 PASS. Complete live event-management and participation acceptance remains pending approved QA data and two-account checks. Health is liveness only.

## Public event retrieval (D3.2)

These GET endpoints remain read-only and unauthenticated. Authenticated writes are
described below, along with participation routes in D4.1. Authentication collections remain separate from event data.
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
matches `noblenest`; the exact configured spelling is passed to MongoDB). Both
`nn_events` and `nn_event_participants` are selected by the event store. One lazy MongoClient per runtime is
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
PUT is unsupported; authenticated join routes are documented below. CORS is not a substitute for JWT authorization.

Writes reuse the existing `nn_events` repository and pooled client. There is no
index execution or new environment variable. Tests use signed fixture JWTs and
isolated BSON-aware collection doubles only. These automated tests do not insert live Atlas records. Production event-write acceptance must be recorded separately using approved QA data.

## Authenticated My Events listing (D3.5A)

`GET /api/events/mine` requires the same verified Bearer JWT, event scope and
active-session checks as event writes. The static route is mounted before the
public `/:id` route; other public reads remain unauthenticated. Cookies, query
parameters and custom identity headers cannot select the creator.

Allowed query parameters are `page` (1-1000, default 1) and `pageSize` (1-50,
default 12). Both are positive decimal integers without leading zeros. Duplicate
keys, unknown keys, nested/operator syntax, decimals, scientific notation,
whitespace, empty values and out-of-range values return 400. The D3.1 pagination
validator enforces the bounds; maximum skip is 49950. Example:

```http
GET /api/events/mine?page=2&pageSize=12
Authorization: Bearer <JWT>
```

HTTP 200 always uses the established event DTO and this pagination envelope:

```json
{
  "events": [],
  "pagination": { "page": 2, "pageSize": 12 }
}
```

An empty list or a page beyond the owner's records is a successful empty result,
not 404. There is no total count or snapshot guarantee. Unlike the public upcoming
feed, My Events includes both past and future owned records, sorted by eventDate
then ID ascending, following the existing repository contract.

The handler calls `listEventsByCreator(req.auth, { page, pageSize })`; the unchanged
repository applies `{ creatorId: verifiedSubject }` inside MongoDB's find operation
and uses the existing DTO projection. No public collection download or browser
filtering is involved. The collection remains `nn_events`; no index operation or
new database connection is introduced.

Matched responses have `Cache-Control: no-store`, including authentication and
query errors. Errors use the established fixed bodies: 400
`{ "error": "Invalid event query." }`, 401
`{ "error": "Authentication required" }`, and database/unexpected failure 503
`{ "error": "Event data is temporarily unavailable." }`. Missing authentication
configuration preserves 503 `{ "error": "Authentication is not configured" }`.
Existing global CORS/body-parser errors retain their behavior. No driver errors,
tokens, configuration values or raw exceptions are returned or logged.

Tests use signed fixture tokens and isolated collection doubles only. Frontend
Manage Events is integrated in the frontend; live ownership/persistence acceptance remains a separate approved production check.

## Event participation (D4.1)

Both endpoints reuse the existing verified Bearer JWT, event scope and active
session middleware. No user identity is accepted from cookies, query parameters,
headers or request bodies. Global CORS, Helmet and 16 KiB body limits still apply.
All matched participation responses use `Cache-Control: no-store`.

| Endpoint | Request | Success |
| --- | --- | --- |
| `POST /api/events/:id/join` | No query parameters or body; ID is 24 hexadecimal characters | 201 `{ "participation": { "id": "...", "eventId": "...", "joinedAt": "UTC ISO timestamp" } }` |
| `GET /api/events/joined` | Optional `page` (1-1000, default 1), `pageSize` (1-50, default 12); no body | 200 `{ "events": [{ "participationId": "...", "joinedAt": "UTC ISO timestamp", "event": { ...approved event DTO... } }], "pagination": { "page": 1, "pageSize": 12 } }` |

An already-joined user receives HTTP 200 with the same participation envelope,
original ID and original join timestamp. It creates no second record. An empty
joined list is HTTP 200 with `events: []`. Static `/joined` precedes public `/:id`.
Creators may join their own events. No extra past-event restriction is introduced;
the referenced event must exist. No Leave Event or attendee listing is provided.

The separate `nn_event_participants` collection stores only server-generated `_id`
(ObjectId), `eventId` (BSON ObjectId), verified `userId`, and `joinedAt` (UTC BSON
Date). It shares the existing event MongoClient pool, database and shutdown path;
Better Auth collections remain separate. Import/startup performs no participation
read, write, collection creation or index initialization.

### Unique index is a mandatory production prerequisite

`npm run participation:indexes:plan` is offline only: no environment loading,
client construction, connection or apply mode. Planned indexes:

- Required `participants_event_user_unique`: `{ eventId: 1, userId: 1 }`, unique.
- Recommended `participants_user_event`: `{ userId: 1, eventId: 1 }`, for filtering
  a user's participation records. Event-date sorting still follows the lookup.

No index is created by these changes. Each join inspects existing index metadata
and fails closed with generic 503 unless the full, unique eventId/userId index is
confirmed by metadata and a successful read hinting that index. Building/hidden,
sparse, partial, non-unique, prepareUnique and non-simple collation
variants do not satisfy the check. An equivalent full index need not have the
planned name. Inspection failure also blocks insertion; there is no override or
cached confirmation. Read-only inspection must establish whether the existing collection/index and permissions satisfy this contract. Any provisioning or modification requires separate owner approval. Do not drop/alter the required index while join writes are active.

The atomic unique constraint, not a read-then-insert check, prevents concurrent
duplicates. Insert duplicate-key code 11000 is recovered only by finding the
exact verified event/user pair; an unrelated collision without that row is 503.
No raw duplicate error, driver metadata or participant identities escape.

### Retrieval and deleted events

Joined retrieval matches userId inside MongoDB, looks up current `nn_events`
details and omits missing/deleted references with an inner unwind. It sorts event
date, event ID and participation ID ascending before bounded skip/limit. No
deleted placeholder or stale event snapshot is returned; empty/orphan-only lists
are empty arrays. Query execution is capped at five seconds and disk spill is
disabled. There is no total count or snapshot guarantee.

Event deletion does not cascade participation deletion. An event deleted between
the existence check and insertion can leave an orphan; subsequent joined reads
omit it. This phase introduces no cross-collection transaction, migration or
cleanup job. A concurrent delete/read can reflect the current query snapshot;
it does not provide a serializable guarantee across collections.

Participation errors use fixed safe bodies: 400 `Invalid event query.`,
`Invalid event identifier.` or `Request body is not allowed.`, 401
`Authentication required`, 404 `Event not found.`, 415 `Unsupported content type`,
and 503 `Participation data is temporarily unavailable.`. Missing auth configuration
retains 503 `Authentication is not configured`. Body-bearing requests are rejected
even if JSON is empty; non-JSON content types are unsupported. Omit Content-Type
for the normal bodyless requests. Duplicate/unknown/operator/malformed pagination
query keys are rejected before storage access. Existing global parsing/CORS error
responses still apply.

Tests use signed JWT fixtures and BSON-aware doubles; no live Atlas operation is
performed. Actual Atlas index enforcement, permissions and aggregation behavior
require separate owner-approved verification before production use.
