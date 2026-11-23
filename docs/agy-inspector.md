# agy traffic in the Inspector (`agy-mitm`)

agy (the Antigravity CLI) workers send their HTTPS traffic through a loopback
forward proxy inside the server. Only the Cloud Code model host is decrypted, and
only with a CA that agy processes alone trust. The proxy passes the bytes
through unchanged and decodes agy's model calls into Anthropic-shaped Inspector
interactions under the worker's instance, billed $0 and shown at Google's API list
price ("Pricing"). agy keeps its own Google
login: Vistaclair never reads, stores or reuses its token (`docs/agy-auth.md`).

| Piece | File |
|---|---|
| listener, CONNECT auth, ALPN mirroring, relay, sha256 proofs, kill switch, notices | `src/agy-mitm.js` (`AgyMitm`, the server instance) |
| name-constrained CA, leaves, `bundle.pem` | `src/agy-mitm-ca.js` |
| ClientHello / ServerHello reader (SNI, ALPN, versions) | `src/agy-tls-hello.js` |
| passive HTTP/1.1 tee parser | `src/agy-h1-tee.js` |
| envelope → Anthropic body, SSE decode, the interaction | `src/agy-trace.js` |
| Gemini SSE options `{ keepThoughts, cacheTokens }` | `src/providers/gemini.js` (opt-in; the :3456 route passes none) |
| tests, fixtures | `test/agy-mitm.test.js`, `test/agy-trace.test.js`, `test/fixtures/agy/` (`real/`: redacted captures of agent turns, the safety monitor, loadCodeAssist and quota from agy 1.5.15) |

## API (for the agy worker engine)

`require('./src/agy-mitm')`. `server.js` calls `configure({ store, broadcaster })`
at boot. That only keeps the references: no port, no CA, no files until the
first `ensureStarted()`.

| Call | Does |
|---|---|
| `ensureStarted()` → `{ port }` | creates or rotates the CA, rebuilds the bundle, listens on `127.0.0.1:0`; idempotent |
| `registerTag(instanceId)` → `{ proxyUrl }` | `http://<instanceId>:<secret>@127.0.0.1:<port>`, the 32-byte secret per worker; stable while the tag lives. For `HTTPS_PROXY` |
| `revokeTag(instanceId)` | forgets the tag and closes its open connections |
| `setMainConversation(instanceId, convId)` | names the worker's main lane (default: the first conversation seen) |
| `port()`, `bundlePath()` | the listener port; `bundle.pem` for `SSL_CERT_FILE` |
| `onCloudCodeResponse(path, json, instanceId, status)` | hook point for quota/tier. The proxy calls it with the parsed JSON of every `loadCodeAssist` / `retrieveUserQuotaSummary` response and every non-2xx model call that agy received, and emits `'cloudcode-response'` on `instance()` |
| `interceptionEnabled()`, `setInterception(on)` | the kill switch (below) |
| `stats(instanceId?)` | counters only: connections, intercepted, tunnelled, rejected, mismatches, notices, bytes per host |

agy's env gets `HTTPS_PROXY=<proxyUrl>` and `SSL_CERT_FILE=<bundlePath()>`. MCP
children must not inherit these.

## Listener

- `http.createServer` with `'connect'` only. A plain proxy request gets 405.
- Basic proxy auth `instanceId:secret`, compared with `timingSafeEqual`.
  Anything else gets 407. Go sends the URL's userinfo on CONNECT.
- The target must be port 443 and a public unicast address. Loopback,
  RFC 1918, CGNAT, link-local, ULA, multicast and `localhost` get 403. Names are
  resolved first, and the connection goes to the checked address.
- 403, 405 and 407 are the only answers the proxy makes itself. They never
  reach Google.

## Hosts and the kill switch

| Host | Handling |
|---|---|
| `daily-cloudcode-pa.googleapis.com`, `cloudcode-pa.googleapis.com`, interception on | TLS terminated, relayed, teed |
| every other host (OAuth, userinfo, telemetry, npm/git from `run_command`) | opaque TCP tunnel; only connections and bytes per host are counted |
| the Cloud Code hosts, interception off | opaque TCP tunnel, like every other host |

Interception is **on** by default. The kill switch is
`<dataHome>/agy-mitm/settings.json` with `{ "intercept": false }` (written by
`setInterception(false)`, re-read when its mtime changes, so it applies to the
next CONNECT without a restart), or the env `VISTACLAIR_AGY_INTERCEPT=0`, which
wins. With interception off, agy workers keep working through the same proxy URL
and bundle, and nothing is recorded.

## Byte identity

What agy sends into the proxy is exactly what goes out, and the reverse.

1. Before terminating TLS, the proxy reads agy's ClientHello (`agy-tls-hello.js`).
   The upstream connection offers exactly agy's SNI and ALPN list. The client
   side then selects what Google selected (`ALPNCallback`). There is no protocol
   downgrade.
2. There is one upstream connection per client connection, opened together and
   closed together. A clean end is passed on as an end, and an abrupt close or
   an error as a close. The proxy makes no retries, probes, extra connections or
   calls of its own. An upstream failure reaches agy as a closed connection,
   never as a synthesized HTTP response.
3. The plaintext is relayed raw both ways (`relay()`): no header is added,
   removed, reordered or re-cased, nothing is re-chunked or decompressed on the
   data path, and keep-alive is untouched. The tee gets each buffer after it is
   written and only reads copies. A tee error stops the tee, never the relay.
4. Proof: a running sha256 per direction, on the read side and the write side.
   At close both pairs are compared (`connection-closed` event: counters, ALPN,
   `match`). A mismatch is logged as an error and recorded as a notice.
5. `h2`: when ALPN selects h2 (an agy that offers it), the bytes are relayed and
   proven the same way but not decoded. One notice per connection,
   "agy negotiated h2 with Cloud Code: relayed, not decoded", goes to the
   worker's lane, a `agy-mitm:notice` broadcast and the log.

Measured with agy 1.5.15 through a peek-only tunnel and through this proxy:

- agy itself offers ALPN `http/1.1` only to Cloud Code (h2 only to
  `play.googleapis.com`), so mirroring keeps HTTP/1.1.
- TLS 1.3 everywhere.
- Keep-alive carries 2–6 requests per connection, and a run uses about 4
  connections.
- gzip is used on the JSON responses (`loadCodeAssist` …), not on the model SSE.
- Go accepts the name-constrained CA, and it rejects a CA whose constraints do
  not cover the host ("DNS name … is not permitted by any constraint").
- A run has the same number of model requests with interception on and off.

**What cannot be identical.** The upstream TLS handshake is Node's, not agy's
Go client's. Its ClientHello, cipher order, extensions and fingerprint are
Node's, the same as behind any corporate TLS-inspecting proxy. Only SNI and the
ALPN list are mirrored; there is no other fingerprint imitation. The certificate
agy sees is the Vistaclair leaf. The upstream handshake completes before agy's
own handshake does (that is how ALPN is mirrored), so a connection that agy then
rejects has opened a TLS session with Google that carries no request.

## CA (`agy-mitm-ca.js`)

- Files are in `<dataHome>/agy-mitm/` (dir 0700): `ca.key` (EC P-256, 0600), `ca.crt`,
  `bundle.pem`, `openssl.cnf`, `settings.json`.
- The CA is made with the system `openssl`. It lasts 90 days and has
  `basicConstraints=critical,CA:TRUE,pathlen:0`, `keyUsage=critical,keyCertSign,cRLSign`,
  and `nameConstraints=critical,permitted;DNS:<each decoded host>`. A leaked
  key cannot sign for any other name.
- `bundle.pem` is the system bundle (`/etc/ssl/certs/ca-certificates.crt`, or Node's
  roots as a fallback) plus `ca.crt`. It is rebuilt at every start. It is
  handed to agy only and never installed system-wide or set as
  `NODE_EXTRA_CA_CERTS`.
- At `ensureStarted` (re-checked at most every 6 h while running) the CA is replaced when it has fewer than 30 days left,
  when the key mode is not 0600, when the key and certificate do not match, or
  when the constraints are missing.
- Leaves last 7 days, are in memory only, one per host, and are re-issued a
  day before expiry. Each leaf key sits in a 0600 temp file in the dir for one
  `openssl` call, because openssl cannot read a key from a pipe.

## Decoding (`agy-trace.js`)

| Path on a Cloud Code host | Use |
|---|---|
| `/v1internal:streamGenerateContent`, `/v1internal:generateContent` | one Inspector interaction each |
| `/v1internal:loadCodeAssist`, `/v1internal:retrieveUserQuotaSummary` | response JSON → `onCloudCodeResponse`, and a marked control interaction (below) |
| anything else | relayed and framed; the body is not read |

- **Request** (`decodeAgyRequest(envelope)`):
  - `model`;
  - `system` from `systemInstruction.parts[].text`;
  - `tools` from `functionDeclarations` (`input_schema` = `parameters`);
  - `messages` from `contents`: text, thought → `thinking`, functionCall →
    `tool_use` (id = `functionCall.id` or `<name>-<turn>-<part>`),
    functionResponse → `tool_result` (matched by id, else by name in order),
    inlineData → `image`. agy sends the tool results under role `model`; a
    turn made only of functionResponse parts becomes a `user` turn, as in the
    Anthropic shape.
  - `generationConfig`: `maxOutputTokens` → `max_tokens`, `temperature` →
    `temperature`, `thinkingConfig` → `thinking` (the "Thinking" section), the
    rest → `generationConfig`. Cloud Code's envelope (`requestType`,
    `requestId`, `sessionId`, `labels`, `userAgent`; never `project`) →
    `agy`. Both show under "Other".
  - `inlineData` over 4 KB becomes `{ type:'image', placeholder:'<mime>, N bytes, sha256:…' }`.
  - `translatedBody` keeps the rest of the envelope (`project`, `requestId`,
    `requestType`, `labels`, `generationConfig`, `sessionId`).
  - A gzip request body is decoded.
- **Response:**
  - Each `data:` line has `.response` unwrapped, then goes through
    `translateSSEChunk(…, { keepThoughts, cacheTokens })` and `finalizeStream`.
    The result is Anthropic events, so the renderer and
    `_reconstructBodyFromSSE` work unchanged.
  - gzip, deflate and br are decoded off the data path.
  - There is a 50 MB cap per message; past it the interaction is marked
    truncated.
  - `traceId`, `responseId` and `modelVersion` go into `response.meta`.
  - The call's model is the one agy requested (`request.model`, also
    `response.body.model`). Google's `modelVersion` is what served it and can
    differ (requested `gemini-4-neon-medium`, served `gemini-4-neon`): it is
    kept apart as `interaction.agy.servedAs` (shown as "Served as" in the
    request info) and never replaces the requested model.
- **Usage:** input = prompt − cached, `cache_read_input_tokens` = cached,
  output = total − prompt (candidates + thoughts, as Anthropic counts output),
  `reasoning_tokens` = `thoughtsTokenCount` (the thinking part of output; the
  tooltip and usage list show it). Each chunk's `usageMetadata` is the running
  total, so the last one wins; `response.meta.usageMetadata` keeps it as sent.
  `response.body.stop_reason` is the finish reason. The closing chunk's empty
  text part is dropped, so no empty text block is shown. Google returns thought
  text only on some calls: on others just a `thoughtSignature`, and then there
  is a thinking token count but no thinking block.
- **Pricing** (`src/agy-pricing.js`): billed $0, because the Google AI
  subscription pays; the Inspector shows what the call would have cost at
  Google's API list prices. `pricing` is the catalog entry
  (`capabilities/models.json`, `getModelPricing`) of the *requested* model
  (`request.model`; a side call uses its own model) plus `apiEquivalent: true`,
  `billedUsd: 0`, `pricedAs` (the catalog name), `credential:'agy-subscription'`
  and `provider:'agy'`. The effort suffix is stripped (`gemini-4-neon-medium` →
  `gemini-4-neon`, `-minimal|-low|-medium|-high|-xhigh`). No catalog entry
  (`gemini-pro-orchestrator-neon`, a new tier) → zero rates and no
  `apiEquivalent`: $0, never a guess. So `computeCost` / `toEntry` give the
  API-equivalent figure from the call's final usage (the closing
  `message_delta`, not `message_start`). Cache accounting needs nothing special:
  `input_tokens` is prompt − cached, `cache_read_input_tokens` the cached part,
  so each token is priced once (input rate / `cacheReadCostPerMTok`);
  `reasoning_tokens` sit inside `output_tokens` and are not priced again; Gemini
  has no cache-write tokens. Control calls stay at plain $0.
  Anthropic subscription calls have no such split: their list price is shown as
  the cost and `credential` marks the bill. The API-equivalent figure is only for
  display: the spend gate settles `/v1/messages` interactions only, so an agy
  call never reaches the ledger or a cap.
  Labels: every cost of an agy call reads `≈ $X` with the tooltip "API-equivalent:
  what this would cost at Google's API list prices. Billed: $0 (the Google AI
  subscription pays)" (timeline row, lane separator and stats, Σ footers, turn
  totals, session cards); the usage bar reads `≈ $X at API prices · billed $0`
  and the cost tooltip lists `API-equivalent` and `billed`. Session totals
  (`session-totals.js`) set `apiEquivalent` (entry slot 11) and the session card
  list carries it; calls recorded before this show $0.
- **Live view:** `interaction:start` when the request is complete, `sse_event`
  per event, then `interaction:complete`, or `interaction:error` for a non-2xx
  response (stored with its JSON body, as a 429 is) or a connection cut off
  mid-response.
- **Lanes:** `requestId` = `agent/<convId>/…`. The main conversation goes to the
  main lane. Any other conversation gets `subagent = { agentId:'agy-<8>',
  agentType }`. `agentType` is the `TypeName` of the `invoke_subagent` call
  seen just before, else `agy-subagent`. `requestType:'image_gen'` is labelled
  `image`.
- **Control calls:** `loadCodeAssist` and `retrieveUserQuotaSummary` are stored
  as `agy.control` interactions in the lane `agy-cloudcode` (the request info
  says "Cloud Code call, not a model call"). Only the response is kept, scrubbed
  by `scrubControl` (keys matching privacy, uri/url, project, email, token,
  notice, credential or secret are dropped, long strings clipped), and an answer
  identical to the tag's last one for that call is not stored again (agy asks on
  every start). The quota answer shows the bucket fractions and reset times.
- **Side calls:** agy sends its own helper requests on the same connection.
  The per-tool safety monitor (agy log `sir_flash_lite` /
  `MODEL_TIER_FLASH_LITE`) is `requestType: 'agent_monitoring'`, model
  `gemini-3.5-flash-lite`, no tools, `requestId` `agent_monitoring/<uuid>`,
  thinking level MINIMAL, and answers a JSON rating. It runs only for tools
  outside agy's own allowlist (seen for `write_file`, not for `read_file` or
  `ls`). `isSideCall`: a `requestType`
  other than `agent` / `image_gen`, a non-streaming call, or a request without
  tools. Such an interaction has `agy.side = true` and its own lane
  (`subagent.agentType = 'agy-side-call'`, the model in its description), and
  never names the main lane. Its model is its own, not the agent's.
- **Persistence:** interactions are saved when the worker's instance has a
  session (`store.registerSession`).

## Redaction

The tee reads every header name inside its receive buffer, but values only for
`content-type`, `content-encoding`, `content-length`, `transfer-encoding` and
`user-agent`. `Authorization`, `Cookie`, `x-goog-*`, `set-cookie` and the proxy
auth are never turned into a string, an object, a log line or an error. Stored
`requestHeaders` holds `content-type` and `user-agent`; `response.headers` holds
`content-type` and `content-encoding`. Errors name the host and path. A test
plants a sentinel bearer, cookie and API key and checks that none of them
appears under the temp data home, in any broadcast, in the store or in
`stats()`.

## Not built

- h2 decoding: h2 is relayed and proven but not decoded; it gets one notice
  per connection.
- A dashboard toggle for the kill switch: today it is the settings file or the
  env.
- Fingerprint imitation of agy's Go TLS client beyond SNI and ALPN.
- Decoding any host other than the Cloud Code hosts.
