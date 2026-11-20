# When the platform is missing something

If you need a widget, bridge method, or capability the platform does not provide, **do not hand-roll it silently** — a bespoke copy in one app is a gap nobody else ever learns about, and it will be re-hand-rolled by the next app (my-podcast's bespoke extend/revise panel existed only because no dialog could host a `vc-*` component at the time). **Ask the platform for it**, the same way you ask another app.

1. **Check the file first.** Read `../PLATFORM_GAPS.md` — if another app already logged the same
   gap, that is a signal it deserves a platform fix rather than a third private copy.
2. **Name the surface.** A platform request names one **bridge method** (`--method email.list`)
   or one **ctx member** (`--ctx email.list`); the platform resolves it to the capability that
   owns it. `--adds` lists the parameters or fields you are missing. As with an app, the
   platform decides whether that is a new surface or a change to a live one, and a change is
   held to backwards compatibility.
3. **Write the request** to `.vistaclair/change-request-platform.md`. The platform session sees
   only this file — it knows nothing about this conversation. State the method or ctx member,
   what it does today, what you need on top, why this app needs it, and one example call.
4. **Tell the user what you are about to request**, then run — with `run_in_background: true` —
   ```
   node ../../platform/scripts/app-change.js request --to platform \
     --prompt-file .vistaclair/change-request-platform.md \
     --method <bridge.method>   # or: --ctx <member.path>
     --adds <p1,p2>             # the parameters or fields you are missing
     --reason "<one line: why this app needs it>"
   ```
   The owner approves or denies in the dashboard. On **done** (exit 0) the outcome tells you
   what the platform now provides — but a platform change only takes effect at the next
   control-room restart, which only the owner performs: do **not** call the new surface in this
   session, and say in your final message that the app needs that restart. **UNVERIFIED**
   (exit 5) means the platform session reported done but the check did not find the change in
   the platform source — a restart will not bring it: treat it like step 5 and say exactly what
   is missing. Denied exits 2; ended or cancelled exits 3.
5. **If it is denied, or the need is outside this task's scope**: build the app-local version —
   the user's change still has to land — say so explicitly in your final message, and append one
   dated line to `../PLATFORM_GAPS.md` (the apps directory root, alongside the app folders —
   create it if absent):
   `- YYYY-MM-DD · <app> · <what was missing> · <what I hand-rolled instead>`
   A missing *platform* capability is a gap. Something another app should provide is NOT a
   gap — request the change from that app instead, see `.vistaclair/app-request.md`.

`PLATFORM_GAPS.md` is the one file outside your app directory you may append to.
