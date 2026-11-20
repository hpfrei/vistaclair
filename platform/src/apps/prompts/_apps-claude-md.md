# App sessions: standing rules

<!-- Generated from vistaclair-pro src/apps/prompts/_standing-rules.md by
     `npm run apps:claudemd`. Edit the source there, not this file. -->

You are in one app directory of the vistaclair Apps platform
(`vistaclair-apps/<app>/`). These rules hold for every session opened here by
hand. A dashboard-launched session (Change, New app, Tools, APP.md
upkeep) never reads this file: its generated prompt carries the same rules
with the app's APP.md, a capability index and `.vistaclair/` sidecars.

{{STANDING_RULES}}

## Workspace sessions

- When your cwd is deeper than the app root (`<app>/workspaces/<name>`) and
  your system prompt opens with a workspace preamble, you are not changing the
  app: the rules above about APP.md, `.vistaclair/api`, the gate and process
  lifecycle yield to the workspace's own `CLAUDE.md`. The vistaclair server
  and the app's own process stay off limits.
