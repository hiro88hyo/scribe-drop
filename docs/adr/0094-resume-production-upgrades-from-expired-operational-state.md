# ADR 0094: Resume production upgrades from an expired operational state

## Context

The first Cloud Run production cutover started from a disabled controller authorization. A later
release starts from the previous successful production finalize state instead. The production
workflow still required disabled/zero during preflight, so the `0.3.0` mutation-free preflight
stopped before any production mutation even though the previous finite authorization had expired
and had no active or reserved execution.

Treating every release as an initial cutover would require an unrecorded manual disable or would
open the new one-execution smoke authorization while the old application still admitted work.
Neither transition is an acceptable promotion prerequisite.

## Decision

- A cutover names the previous successful production finalize run. The workflow downloads its
  immutable production release evidence, verifies the successful finalize jobs and artifact, and
  derives the exact previous operational epoch, budget, and expiry from that evidence.
- Upgrade cutover is allowed only after the previous finite authorization has expired. Live
  authorization must be one of three exact prefix states: the evidenced previous operational state,
  disabled/zero, or the same cutover run's unconsumed smoke state. Active or reserved executions,
  another epoch, or another budget fail closed.
- The new application is deployed with Cloud Run selected and admission paused before provider
  drain. The expired previous authorization is then changed to disabled/zero with a Firestore
  update-time precondition. Only after that convergence may the new controller and exact-one smoke
  authorization be applied and admission reactivated.
- Rerunning the same failed cutover job is idempotent from the disabled and same-run smoke prefix
  states. A new dispatch cannot claim a different smoke epoch as its own.
- This deployment-only correction does not alter the application candidate, Cloud Run image,
  migrations, or environment policy. It therefore reuses the successful staging lifecycle and
  reissues only short-lived acceptance evidence; it does not rebuild or execute another GPU job.

## Consequences

- Subsequent releases require a previous production finalize run ID in addition to staging evidence
  and mutation-free preflight evidence.
- A release cannot cut over while the previous finite operating window remains valid. Operations
  must wait for expiry rather than silently revoke an active reviewed window.
- Production upgrade entry, quiesce order, and every resumable authorization prefix are enforced by
  source-managed verifiers and regression tests.

## Status

Accepted
