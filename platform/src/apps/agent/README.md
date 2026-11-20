# `src/apps/agent/` — Horst himself

The half that senses, classifies, remembers and proposes. Everything in here
observes the world or forms a judgment about it; **none of it acts**. An act
leaves this directory as a request to `../governance/`, and comes back only as
an approved, frozen payload.

Two exceptions act directly, each on a standing owner setting rather than on
Horst's own initiative: triage's `fileSpam` (`autoFileSpam`, moves a fresh
spam arrival to `Spam`) and `horst-reminders.js` (`eventReminders`, messages
the owner about their own calendar).

Requiring the governance side from here is fine — that is the permitted
direction. The reverse is not: see `../governance/README.md`.

What is deliberately NOT here:

- **No cognition pipeline, no work stack, no planner.** What starts work is a
  routine bound to an event kind, the email triage sweep, a due mission
  review, or the owner in chat (`docs/horst.md`, "How Horst acts").
- **No second implementation of a platform duty.** A read Horst needs is a
  read-only tool on the capability that owns the data; an act is a kind on the
  same capability. This directory holds the judgment, never a private copy of
  the engine underneath it.
