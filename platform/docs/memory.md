# Memory — the shared knowledge store

One platform store every app reads and writes (`ctx.memory.*`, capability
`memory`), tended by Horst. Code: `src/apps/memory-service.js` (schema, writes,
recall, owner curation), `src/apps/memory-maintenance.js` (the passes),
`src/apps/embeddings.js`, `src/apps/agent/horst-brain.js` (prompt assembly).
MariaDB database `vc_platform_memory`; no second server.

## Layers

| Layer | Table | Written by |
|---|---|---|
| Intake | `memory_observations` — raw, append-only, idempotent per `(app_origin, natural_key)` | `remember` / `rememberBatch` (one INSERT, no AI) |
| Knowledge | `memory_facts` (subject · predicate · value, 384-d vector, tier, importance, `hit_count`, `expires_at`, `valid_to`, `superseded_by`), `memory_entities` | the consolidator |
| Provenance | `memory_sources` (insert / reinforce / supersede / merge / forget), `memory_sources_archive` | every pass and every owner curation |
| Bookkeeping | `memory_maintenance_runs`, `memory_meta` (churn, locks, one-time flags) | the passes |
| Documents | `memory_artifacts` (`agent/horst-artifacts.js`) — mined into facts carrying `artifactId` | artifact filing |

Nothing is hard-deleted: retiring a fact stamps `valid_to`, and `history()`
walks the ledger.

Embeddings: `multilingual-e5-small`, asymmetric `query:` / `passage:`
prefixes, `embed_v` per row with a self-healing re-embed at boot. Facts are
stored in canonical English, observations in their original language.
Distance thresholds in `memory-maintenance.js` are calibrated for e5 and must
be re-checked on any model swap.

## Recall

`recall({ query, subject?, limit?, withSources?, distill?, reinforce? })`
- Vector ANN and FULLTEXT over live, unexpired facts (`valid_to IS NULL AND
  (expires_at IS NULL OR expires_at > NOW())`), fused by reciprocal rank
  (K 60, ×1.25 when both paths hit, ×1.15 for the long tier).
- Every unconsolidated observation matching by FULLTEXT is unioned in as
  `recent` (`pending: true`), with no age window, so nothing written is
  invisible while consolidation is behind or paused.
- Scope at every read: shared/global, or private when `app_origin` is the
  caller. `forget` needs ownership; `ownerForget` / `ownerSupersede` (Horst
  chat markers only) outrank it and write ledger rows.
- **Reading is not using.** Only `reinforce: true` bumps `hit_count` /
  `last_seen`, and only Horst's `memory_search` pull passes it. Tasters,
  triage, drafting, governance and the Brain browser read without reinforcing.
  Re-observation reinforces through the consolidator.
- `distill: true` adds the one optional model call (`memoryAiModel`, no tools).

## The long tier is never forgotten

Retention and compaction touch `tier='short'` only. A fact is long when:

| Route | Where |
|---|---|
| Durable record: the extractor's `durable` (contracts, bills, invoices, payments, obligations, legal/financial/medical/tax records, warranties, project issues and decisions) | `reconcileAndPersist` |
| From a filed document: the observation's `source_ref` carries `artifactId` (mail attachments arrive as `type:'email'`) | `durableSource()` |
| Owner-stated: `<horst-remember>` (`source.type 'horst-chat'`) and `<horst-supersede>` | `durableSource()`, `ownerSupersede` |
| Promoted: `hit_count ≥ memoryPromoteHitCount` or importance ≥ 0.8, and no expiry | retention pass |

Durable facts are records, not state. A new value for the same subject and
predicate is stored alongside ("October's bill" does not supersede
"September's"). They never carry an expiry: their dates live in the value.

## Consolidation (every 10 min, `memory.consolidate`)

1. Guards, within the observation's own app and scope. An identical
   already-consolidated observation, or a live fact within 0.05 cosine with
   the same numbers (`sameNumbers`), is marked done and the fact reinforced.
   No model call.
2. Grouped extraction (≤15 observations / 12k chars per call, `memoryAiModel`,
   `allowedTools: []`). The output per fact is `subject, predicate, value,
   importance, confidence, durable, expires`. A failed extraction degrades to a
   raw `note` fact at importance 0.25.
3. Reconcile, per observation in one transaction:

| Situation | Result |
|---|---|
| Same value already live | reinforce |
| No live row, or a durable fact | insert (long if durable) |
| Live row is short, new value confident (≥0.5) | supersede; ledger chains to the old row |
| Live row is long, or new value doubtful | insert alongside at 0.7× importance, and a G10 question on the agenda (`memory-conflict`, ≤3 per run) |

A fact whose `expires` date has already passed is not stored.

## Retention (daily 04:00, `memory.decay`)

Importance is what the extractor or owner assigned; time never changes it.
All three steps below apply to the short tier only:

- **expire**: `expires_at` passed → retired, with a `forget` ledger row `{job:'expire'}`;
- **promote**: see the table above;
- **prune**: `hit_count = 0`, importance `< memoryImportanceFloor` (0.3), and
  unseen for `memoryShortTtlDays` (14) → retired. A fact is forgotten because
  it was minor from the start and never came up again.

`durable_v1` is a one-time repair for the retired nightly decay. It lifts
crushed importances to the floor, promotes facts with artifact or owner
provenance, and restores such facts the decay had pruned. Facts that were
forgotten, superseded, folded or already re-mined are left alone.

## Compaction (weekly, churn ≥ 50) and archival (monthly)

- **Compaction**: one self-join over short-tier pairs sharing subject,
  predicate, app and scope within `1 − memoryDedupeCosine` distance and
  carrying the same numbers. The newer row is folded into the older (hits
  summed, `merge` ledger row). The long tier, and a contradiction stored
  beside a long fact, are never folded.
- **Archival**: ledger rows older than `memoryLedgerRetentionDays` whose fact
  is retired move to `memory_sources_archive`.

All passes are idle-gated (a guard query, then nothing) and run under a
`memory_meta` lock. They stop while Horst is paused or `memoryMaintenance` is
off (user mandate), and `memoryMaintenanceEnabled` is the platform master
switch. A pass that changed something publishes `memory:consolidated`.

## Horst's brains (`agent/horst-brain.js`)

Brains register as `{ name, taster, tools[] }`. The assembler composes the
tasters under a hard 1,600-byte budget (whole sections dropped from the end),
so push cost never grows with the store and depth comes from pull tools:
`memory_search`, `todo_list`, `decision_stats`, `artifact_search/get`,
`mission_list/get`, `events_history`, capped at 30 calls per session.

The chat memory taster queries with the user's message. A short turn
(< 80 chars, "yes, do that") is prefixed with Horst's previous reply
(`brainQuery`, `platform-horst.js`).

Taxonomy: constitutional → goal → prospective → semantic → preference →
episodic (procedural unbuilt).

## Not built

- Entity relations / a graph (`memory_relations` was never written and is no
  longer created).
- As-of recall ("what was true on date X") and a separate `valid_from`.
- A relevance cutoff on the vector path. The nearest facts are returned even
  when unrelated, which only matters for prompt noise now that reads don't
  reinforce.
- Predicate normalisation. Free-form predicates from the extractor make
  supersede miss, so both values stand.
- Rolling conversation summaries and content search over past conversations.
- Private → shared promotion with consent; procedural memory (playbooks).
