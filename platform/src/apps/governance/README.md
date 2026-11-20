# `src/apps/governance/` — the approval plane

The half of Horst that decides nothing and judges nothing: it takes a request
for an act, works out whether the owner has already answered it, renders it as
a card, records what the owner said, and executes exactly the payload that was
frozen. *The engine enforces, Horst judges, the owner decides* — this directory
is the third clause.

**The rule the directory exists to state: nothing in here may require a module
from `../agent/`.** The dependency runs one way. Where governance genuinely
needs an agent-side executor it takes it as a launcher —
`registerLauncher(kind, fn)`, registered by `platform-horst.init`. `mission.create`
is the live example: its executor lives in `agent/horst-missions.js`.

Capability modules (`../capabilities/*.js`) may require from here freely —
`horst-identity` in particular, for their kinds' `identity()` functions.

`horst-facet.js` stays at `src/apps/` rather than moving in here: the
capability modules use it as well as governance's validators, so it belongs to
neither side.
