# When another app must change

Sometimes the feature you need belongs in **another installed app**: it owns the data, the
device or the account, and this app should merely call it. Never copy that feature here, and
never read the other app's database, files or routes. Request the change instead — the owner
approves it, a change session opens on that app, and you are told the outcome.

1. **Decide the interface.** Only two things can be requested: a **tool** the other app
   registers with `expose: 'apps'` (you will call it with `ctx.tools.call`), or an **event
   kind** it declares and emits (you will receive it with `ctx.events.subscribe` /
   `Bridge.bus`). A shared table, file or HTTP route is never the answer.
   This covers an interface that **already exists but does not go far enough** — a tool that
   is right except that it cannot take the one parameter you need, or a kind that does not
   carry the field you need. Ask for the change; do not clone the tool, do not work around it
   by reading the other app's data, and do not give up on it. Name the same tool or kind you
   already see in the platform tool list. The platform works out whether that is a new
   interface or a change to a live one, and a change is held to backwards compatibility: the
   other app adds optional parameters and extra result fields, so your call and everyone
   else's keep working.
2. **Write the request** to `.vistaclair/change-request-<app>.md`. The other session sees
   only this file — it knows nothing about this conversation. State the interface name, the
   input schema, the result shape, why this app needs it, and one example call. When the
   interface already exists, say what it does today, what you need on top, and what must not
   change.
3. **Tell the owner in your reply** what you are about to request and why, then run — with
   `run_in_background: true` —
   ```
   node ../../platform/scripts/app-change.js request --to <app> \
     --prompt-file .vistaclair/change-request-<app>.md \
     --tool <name>            # or: --event <kind>
     --adds <p1,p2>           # the parameters or payload fields you are missing
     --reason "<one line: why this app needs it>"
   ```
   `--adds` is what makes the outcome checkable: the platform snapshots the interface now and
   compares it when the other session reports done, so a tool that never actually changed is
   not reported to you as delivered.
   Do **not** use AskUserQuestion for this: the owner approves or denies in the dashboard,
   and a second question would ask the same thing twice.
4. **Keep working on what does not depend on it**, but do not use the interface before the
   outcome arrives. The outcome reaches you as a task notification:
   - **done** (exit 0) — use the interface as the message describes. If it says the change
     was not backwards compatible, do not paper over it: tell the owner exactly what broke.
   - **UNVERIFIED** (exit 5) — the other app reported done, but the platform could not find
     the change; the message says what is missing. Do not use the interface. Ask the owner to
     restart that app, then run `status --id <id>`, which checks again; if it is still
     unverified, proceed without it and tell the owner exactly what is missing.
   - **denied** (exit 2) — the owner said no, with a reason. Do not ask again. Build what you can
     inside this app and say plainly in your final message what is missing.
   - **ended** or **cancelled** (exit 3) — ask the owner how to proceed.
   If no notification ever arrives, `node ../../platform/scripts/app-change.js status
   --id <id>` prints the current state.

One request at a time, and it may be refused: a session that was itself opened by a change
request can only request a third app when the platform's hop limit allows it — the refusal
says so, and then a `PLATFORM_GAPS.md` line is the right move.
