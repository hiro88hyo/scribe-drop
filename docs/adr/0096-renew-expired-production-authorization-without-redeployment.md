# ADR 0096: Renew expired production authorization without redeployment

## Context

Production Cloud Run GPU authorization is intentionally finite. The authorization created by production finalize expired while the deployed application, controller image, migration set, provider selection, and release evidence remained unchanged. A queued production job consequently stayed in `SUBMISSION_PENDING`, and every controller request failed closed with `BUDGET_EXHAUSTED` before creating a Cloud Run Job or Execution.

Re-running candidate publication, staging acceptance, cutover, or finalize would repeat already-proven application work and could consume another GPU execution. A dashboard-only or local one-off update would not preserve the operational prerequisite or a safe recovery path in source.

## Decision

Add a `renew` operation to the existing production promotion workflow. It uses the existing production Environment, concurrency group, release-branch-bound workload identity, deployer service account, and pinned Google Cloud CLI. It does not download, rebuild, publish, migrate, deploy application code, change provider selection, or run a synthetic E2E.

The operation binds the exact expired epoch, expiry, execution cap, and currently deployed immutable controller image digest. A new epoch keeps the deployed candidate commit identity and uses the stable GitHub run ID. The renewed window permits 1–20 executions, charges exactly 250 JPY per execution, and expires between 30 minutes and 24 hours after validation.

Renewal has two remote mutations:

1. update only the six controller Service authorization environment variables;
2. conditionally update the Firestore authorization document by `updateTime`, reset the expired epoch's cumulative reservation counters, and preserve all unrelated fields.

The state machine accepts only the four exact prefixes `expired`, `service-updated`, `firestore-updated`, and `active`. Before an inactive prefix is changed, the workflow requires zero Cloud Run Jobs and Executions and zero active Firestore execution. Service/document mismatch therefore remains fail-closed and a rerun resumes the remaining suffix. The final read-back permits a pending user job to have consumed one bounded slot after activation. A secret-free evidence artifact records the converged epoch, digest, cap, reservation count, and expiry.

## Consequences

- An expired operational window can be reopened without changing or rebuilding the release candidate.
- Production remains unavailable until both authorization copies exactly match; partial application cannot authorize a GPU execution.
- The workflow must be dispatched from `release/*` because the existing production workload identity condition requires that ref and exact workflow path.
- Authorization remains deliberately temporary. A future scheduler or operator must renew it again before expiry if continuous availability is required.

## Status

Accepted
