Redacted Cloud Code (`v1internal`) shapes from the agy 1.5.15 spike captures:
envelope keys, `request` keys, part kinds and the SSE `{response, traceId,
metadata}` wrapper are as captured; ids, project, prompts and signatures are
synthetic. Used by `test/agy-trace.test.js` and `test/agy-mitm.test.js`.

`real/` holds redacted captures of real agy 1.5.15 calls (project, account, ids and
thought signatures replaced; the system prompt cut and the tool list trimmed to three).
