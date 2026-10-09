Build the UI bridge and the browser's API client (D-117). You're the first UI task. The other five build on your files, so keep their exported names exactly as written here.

SCOPE: packages/ui/src/, packages/ui/web/api.ts, packages/ui/test/bridge.test.ts, packages/ui/test/api.test.ts

READ FIRST, and only these:
- test/fixtures/ui-contract/README.md: the layout and the rules. Rules 1 to 4 bind you.
- docs/protocol.md §12: the uirpc methods and the bridge contract.
- packages/protocol/src/index.ts: the `ProjectSnapshot` type and what it contains.
- packages/daemon/src/uirpc.ts: the server you talk to (read only).
- packages/daemon/src/config.ts: read `loadConfig`, `harnessHome` and the `ui.port` field.

BUILD:
1. **`src/uirpc-client.ts`.** `class UirpcClient`:
   - Constructor: `{ connect: () => Duplex, token: string, timeoutMs?: number }`. `connect` defaults to `net.connect(socketPath)`. Tests pass an in-memory Duplex, because agents' sandboxes can't open Unix sockets.
   - `call(method, params): Promise<unknown>` sends one NDJSON request `{ id, token, method, params }`, matches the reply by id, and rejects with `UirpcError { code, message }` on `ok: false` or a timeout (default 10 s).
   - `events(onPatch)` subscribes to the stream and reconnects with backoff (1, 2, 5, 10 s) when the socket closes.
   - Never log the token.
2. **`src/bridge.ts`.** `startBridge({ port, uirpc, webRoot, secret, now? })` returns `{ url, close() }`.
   - **Binding:** listen on `127.0.0.1:port` only. If the port is taken, throw `BridgeError('port_taken')`; never pick another.
   - **Every request:**
     - `Host` must be exactly `127.0.0.1:<port>`, and `Origin`, when present, `http://127.0.0.1:<port>`. Otherwise 403.
     - Headers on every response: `Content-Security-Policy: default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'`, plus `X-Content-Type-Options: nosniff` and `Referrer-Policy: no-referrer`. `/api/*` responses also get `Cache-Control: no-store`.
   - **Launch:** `POST /api/launch {nonce, mac}`.
     - `mac` = HMAC-SHA256(secret, `"launch:" + nonce`), checked in constant time.
     - It returns `{ token, proof }`, where `proof` = HMAC-SHA256(secret, `"bridge:" + nonce`). The token is 32 random bytes in hex, single-use, and valid for 60 s.
   - **Session:** `POST /api/session {launch_token}` returns `{ session_token }` (32 random bytes in hex), kept in memory and lost when the bridge restarts.
     - A token that was already used, has expired or is unknown gets 401.
   - **`/api/*`:** every other `/api/*` route needs `Authorization: Bearer <session_token>`. State-changing ones also need `Content-Type: application/json` and a body of at most 64 KB. The routes:
     - `GET /api/snapshot` → `snapshot`;
     - `GET /api/health` → `health`;
     - `GET /api/approvals` → `pending_approvals`;
     - `POST /api/approvals/:id {decision: 'approve'|'deny', shown_hash?}` → `approve` or `deny`;
     - `POST /api/command {project_id, name, args, command_id}` → `command`;
     - `POST /api/dispatch {project_id, kind, task_id, expected}` → `dispatch`.
     - Map a `UirpcError` to an HTTP status: not_found 404, conflict 409, forbidden 403, bad_request 400, not_available 501, anything else 502. The body is `{ error: { code, message } }`.
   - **Stream:** `GET /api/stream` returns `application/x-ndjson`, one line per snapshot patch, plus a `{"keepalive":true}` line every 15 s.
   - **Static files:**
     - `GET /` and `GET /launch` serve `web/index.html`. Any other path serves a regular file under `webRoot`, resolved with `fs.realpathSync` and required to stay under it. Otherwise 404.
     - MIME types: `.html` text/html, `.css` text/css, `.ts` and `.js` text/javascript, `.json` application/json, `.svg` image/svg+xml.
     - `.ts` is served through `module.stripTypeScriptTypes` from `node:module`.
3. **`src/main.ts`.**
   - `node packages/ui/src/main.ts serve`:
     - reads the config;
     - creates `~/.harness/ui/bridge.secret` once (32 random bytes, 0600, in a 0700 directory);
     - reads `~/.harness/run/uirpc.token`;
     - connects to `~/.harness/run/harnessd.sock`;
     - starts the bridge on `ui.port`.
   - `node packages/ui/src/main.ts open`:
     - calls `/api/launch` with a fresh nonce;
     - checks `proof` in constant time; a wrong one prints "something else holds the UI port" and exits 1;
     - then runs `/usr/bin/open http://127.0.0.1:<port>/launch#t=<token>`.
4. **`web/api.ts`** (browser; it imports types only):
   - `startSession(): Promise<void>`:
     - reads `t` from `location.hash`;
     - POSTs `/api/session`;
     - stores the session token in `sessionStorage['harness.session']`;
     - clears the fragment with `history.replaceState`.
   - The functions:
     - `snapshot(): Promise<ProjectSnapshot[]>`;
     - `stream(onSnapshot, onState)`, where `onState` is `'live'|'reconnecting'`. It uses `fetch` with a body reader and reconnects on any end;
     - `health()`, `approvals()`;
     - `approve(id, shownHash)`, `deny(id)`;
     - `command(projectId, name, args, commandId?)`;
     - `dispatch(projectId, kind, taskId, expected)`.
   - **Errors:** `class ApiError { status; code; message }`. A 401 clears the session and throws `ApiError` with code `session_expired`.

TESTS. Write them first, then make them pass. Run only:
- `node --test packages/ui/test/bridge.test.ts`
- `node --test packages/ui/test/api.test.ts`
- `node node_modules/typescript/bin/tsc -p packages/ui/tsconfig.web.json`
- `node node_modules/typescript/bin/tsc -p .`

**`bridge.test.ts`** uses an in-memory fake uirpc, a temp `webRoot` and port 0. Each refusal has a matching success as its control. It covers:
- a wrong Host, and a wrong Origin;
- no token, a bad token, a reused launch token, and an expired one (inject `now`);
- the CSP and the other headers;
- static path traversal (`/../`, `%2e%2e`, a symlink out of the root);
- a `.ts` file served with its types stripped;
- each route mapped and each error code mapped;
- a body over 64 KB;
- the HMAC launch, with a wrong `mac` refused;
- `port_taken`.

**`api.test.ts`** runs `web/api.ts` in Node, against a stub `fetch`, `sessionStorage`, `location` and `history`. It covers:
- the session swap, and the fragment cleared;
- the bearer header on every call;
- a 401 clearing the session;
- `stream` reconnecting after the body ends.

DONE WHEN: every listed command passes. Each refusal above has a test with its control. No file outside SCOPE is changed. Then call `report_done` with a two-line summary.
