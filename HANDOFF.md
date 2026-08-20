# Phase 16 production release handoff

## Repository state

- Repository: `/home/hiroyuki/projects/scribe-drop`
- Branch: `release/0.2.0`
- Base head: `bbfaa8c69e725e2fafbe8257a8b16e409d42fbbf`
- The continuation after this base contains the complete-preflight
  implementation described below.

Read `AGENTS.md` and `docs/implementation-plan.md` before continuing. Treat the
remaining work as Phase 16.

## Non-negotiable operating constraints

- Do not use GitHub Actions workflows as a debugging mechanism. Do not fix one
  failed step and immediately redispatch.
- Before any dispatch, mechanically enumerate and read-only verify every input,
  permission, artifact, external resource, and ordering precondition used by the
  target workflow.
- Promote that verifier and its regression tests into the repository; do not
  leave a one-off `/tmp` probe as the only protection.
- Do not run GPU execution or production cutover without the user's explicit,
  fresh approval. Production cutover requires explicit approval for exactly one
  L4 GPU execution with a maximum cost of 250 JPY.
- Do not change CI, cloud resources, or GitHub Environment configuration without
  first reporting the read-back evidence and required exact change to the user.
- Never emit secrets, tokens, signed URLs, or credential values in logs, test
  output, commits, or user-facing messages.

The user is understandably frustrated by repeated workflow failures. Provide
facts and test results, not reassurance. Do not say that a rerun is safe unless
the complete preflight result demonstrates it.

## Immutable candidate and staging evidence

- Application candidate commit:
  `bb90669e229ca91df582f36455acfdad4837125f`
- RunPod candidate workflow run: `31917062023`
- Cloud Run candidate workflow run: `31916576563`
- Latest GPU-free staging recovery acceptance: `31924003518` (successful)
  - It reverified real M4A source lifecycle `31921380251` and current live
    parity, then issued short-lived acceptance evidence.
  - GPU, migration, RunPod/Pages/Orchestrator deployment jobs were skipped.
  - Candidate and acceptance artifacts were independently downloaded and
    verified locally.

Relevant URLs:

- Staging acceptance:
  `https://github.com/hiro88hyo/scribe-drop/actions/runs/31924003518`
- Failed production preflight:
  `https://github.com/hiro88hyo/scribe-drop/actions/runs/31924206961`

## Latest production-preflight result

Production preflight `31924206961` failed before every production mutation.

Passed:

- candidate, artifact, and staging-acceptance identity checks
- production Cloud Run foundation read-back
- initial-production controller preflight, including the absent-Service path

Not executed:

- migrations and R2 policy application
- RunPod promotion
- Cloud Run controller apply
- Worker/Pages deployment
- provider drain or provider selection
- GPU authorization or GPU execution
- cutover evidence issuance

The failure was in `Render disabled preflight configuration`:

```text
SCRIBE_DROP_PRODUCTION_RUNPOD_GPU_IDS is missing or invalid
```

The production GitHub Environment value observed by the workflow contained only
two GPU candidates:

```text
NVIDIA GeForce RTX 5090,NVIDIA GeForce RTX 4090
```

The source-controlled fixed policy requires exactly this ordered set:

```text
NVIDIA GeForce RTX 5090,NVIDIA GeForce RTX 4090,NVIDIA RTX PRO 6000 Blackwell Server Edition
```

The policy is defined in `scripts/runpod-environment-config.mjs` as
`fixedGpuTypeIds`; its behavior is covered by
`scripts/runpod-environment-config.test.mjs`.

This was a known, externally readable precondition that should have been
validated before dispatch. It must be included in the complete production
preflight described below.

## Latest committed fix

`bbfaa8c fix(release): allow absent production controller preflight`

For an initial production deployment, the controller Cloud Run Service does not
yet exist. The previous preflight performed a validate-only PATCH before
handling that state and received a 404. The new behavior:

- skips the validate-only PATCH when the Service is absent;
- still performs the permitted read-only control-plane preflight;
- retains validate-only PATCH plus before/after snapshot equality when the
  Service already exists.

Files changed:

- `scripts/cloud-run-controller-deployment.mjs`
- `scripts/manage-cloud-run-controller-deployment.mjs`
- `scripts/cloud-run-controller-deployment.test.mjs`
- `docs/implementation-plan.md`

The full gate succeeded after this commit:

```text
pnpm check
```

It included formatting, lint, TypeScript and Python typechecks, 315 script
tests, 452 TypeScript tests, 122 Worker tests, 268 Python tests, builds, D1
verification, and CI workflow static verification.

## Earlier release-control commits

- `d8e51ed`: GPU-free recovery evidence for an already successful staging
  lifecycle.
- `2ac12f1`: mutation-free production preflight-only workflow.
- `9ae290b`: consume GitHub Environment-exported candidate identity in a
  separate workflow step.
- `bbfaa8c`: initial production controller absent-Service preflight fix.

## Required next work — do not redispatch first

1. Build a repository-managed, read-only, complete production preflight.
   It must enumerate the actual workflow steps and validate their inputs and
   prerequisites before any `deploy-production-candidate.yml` dispatch.
2. At minimum, cover:
   - GitHub production Environment variables, including the exact ordered
     `SCRIBE_DROP_PRODUCTION_RUNPOD_GPU_IDS` value;
   - required secret _presence only_, never secret values;
   - immutable candidate and staging-acceptance identities;
   - Cloud Run foundation, Service, IAM, and Firestore prerequisites;
   - Cloudflare Worker route, Pages, Access, secret-name, and deployment
     prerequisites;
   - RunPod plan, endpoint, and fixed GPU policy;
   - workflow ordering and all mutation guards.
3. Add regression tests for the complete verifier and run the full local gate.
4. Read the actual production Environment value with a read-only GitHub CLI/API
   command. If it must change, show the user the observed and required values
   and obtain approval before changing it.
5. Decide explicitly whether that configuration correction invalidates the
   staging evidence under `AGENTS.md` promotion-gate rules. Do not silently
   assume either answer.
6. Only after the full read-only preflight succeeds should a new mutation-free
   production preflight workflow be dispatched.
7. A successful production preflight is still not cutover authority; get the
   separate exact-one L4/250-JPY approval before dispatching cutover.

## Continuation status (2026-08-20)

The repository-managed preflight is implemented in this continuation:

- `production:environment:verify` reads all 15 production Environment values,
  renders the actual production Cloudflare/RunPod configuration, verifies both
  immutable candidates, and compares the normalized production policy with the
  staging evidence in one pass.
- `production:workflow:verify` mechanically fixes the exact 15 variable and 6
  secret references and verifies the production policy producer, external
  preflight, and RunPod promotion ordering.
- the cutover job now exports and verifies the production environment policy
  before external access, so actual RunPod promotion receives the required
  `EXPECTED_ENVIRONMENT_POLICY_ID`.
- regression tests cover the two-GPU drift, multiple simultaneous drift,
  missing/extra values, policy mismatch, missing producer, and unreviewed
  workflow references. They also require the staging run input under the exact
  shell variable name consumed by the policy verification step.

Read-only live results:

- `production:environment:verify` found exactly one Environment mismatch:
  `SCRIBE_DROP_PRODUCTION_RUNPOD_GPU_IDS`. In-memory replacement with the
  source-reviewed ordered three-GPU value made all 15 values and staging policy
  parity pass. The external value has not been changed.
- `github:controls:verify:production` passed: 3 protected branches, 15
  variables, and 6 secret names.
- `cloud-run:foundation:read production` passed after supplying the non-secret
  HMAC version variable to the local process. No foundation mismatch remains.
- no workflow was dispatched and no CI, cloud, GitHub Environment, GPU, or
  production resource was changed during this continuation.

The previous staging acceptance is expired and the source/workflow changes also
invalidate it for promotion. It is used only for structural policy comparison.
After the full local gate and commit, obtain explicit approval before correcting
the one GitHub Environment value, then issue one new GPU-free staging recovery
acceptance before the single production remote preflight.

Later continuation results:

- production Environment GPU IDs were corrected and all 15 values plus policy
  parity passed.
- GPU-free staging recovery run `32312021835` succeeded with every deployment,
  migration, real acceptance, recovery, and GPU job skipped.
- production preflight `32312333527` safely stopped on the documented RunPod
  capacity gate. The approved local-only manager changed the idle/zero endpoint
  from two fixed European data centers and two GPUs to Any Region and the fixed
  three-GPU set; strict capacity and health read-back passed.
- replacement preflight `32313523493` passed RunPod with `capacity ready`, then
  stopped because the final Wrangler Pages deployment list inherited the
  backend Cloudflare token instead of the already-present dedicated Pages
  token. All mutation steps were skipped. The current source change binds only
  that Wrangler process to `CLOUDFLARE_PAGES_API_TOKEN` and adds a static
  regression gate. A new GPU-free acceptance is required after committing it.

## Toolchain

Use Volta and pnpm:

```bash
PATH=/home/hiroyuki/.volta/bin:$PATH VOLTA_FEATURE_PNPM=1 pnpm check
```

For the Python cache during a full gate:

```bash
PATH=/home/hiroyuki/.volta/bin:$PATH VOLTA_FEATURE_PNPM=1 \
  UV_CACHE_DIR=/tmp/scribe-drop-uv-cache pnpm check
```

The GitHub CLI may intermittently fail in the sandbox with a connection error.
Retry necessary read-only commands with the approved elevated-network path; do
not treat that sandbox failure as a repository or service failure.

## Investigation findings (recorded before building the verifier)

### Defect #2 semantics — established and fixed locally (2026-08-20)

`EXPECTED_ENVIRONMENT_POLICY_ID` has exactly three consumers:

- `scripts/promote-runpod-candidate.mjs:101-119` — for
  `production && !preflightOnly` it is **required** (throws
  `Production promotion evidence is missing` when undefined) and is passed
  to `verifyStagingAcceptance`.
- `scripts/verify-staging-acceptance.mjs:26` — **optional** (undefined skips
  the check). Used by the finalize job after its own export.
- `scripts/release-acceptance.mjs:200-202` — the comparison itself:
  `evidence.environmentPolicyId !== input.expectedEnvironmentPolicyId` throws
  `Staging acceptance environment policy does not match`.

The evidence's `environmentPolicyId` is the **staging** normalized policy ID,
exported by `environment:policy:export staging` inside the staging workflow
before `staging:acceptance:create` (`.github/workflows/deploy-staging-candidate.yml:678`
acceptance path, `:892` resume path). `scripts/export-environment-policy.mjs`
writes both `ENVIRONMENT_POLICY_ID` and `EXPECTED_ENVIRONMENT_POLICY_ID`
(same value) to `GITHUB_ENV`.

Parity is by design: `scripts/environment-parity.mjs` normalizes
environment-specific values to placeholders (`$ENVIRONMENT`, `$WEB_ORIGIN`,
`$ORCHESTRATOR_ORIGIN`, `$R2_HOST`, CORS/lifecycle rule IDs) and
`normalizedCloudRunPolicy` output does **not** include the runtime mode, so a
production export and the staging evidence ID must be equal when the
environments are at parity. The raw RunPod template image is included
un-normalized, but both plans render from the same immutable candidate, so
they match. `createEnvironmentPolicy` additionally requires
`gpuExecutionAdmission === "active"` and
`gpuExecutionPolicy === "cloud_run_jobs_l4_v1"` and, for production,
`cloudRunRuntimeMode === "active"`.

Before the current uncommitted fix, the production workflow had **no** policy
export in the cutover job. The only `environment:policy:export production` was
in the finalize job
(`.github/workflows/deploy-production-candidate.yml:666`, step
`Verify final parity, Access, and accepted artifact identity`), which feeds
the optional check. The cutover job's RunPod promotion step (line 375,
`pnpm run runpod:promote:production`, guarded by `!inputs.preflight_only`)
therefore fails with `Production promotion evidence is missing` on an actual
cutover dispatch. A `preflight_only=true` dispatch is **not** affected
(`--preflight-only` takes the other branch).

Applied in the current worktree: a step in the cutover job after
`Render disabled preflight configuration`
(which already writes `.wrangler/deploy/r2-cors-production.json`,
`r2-lifecycle-production.json`, `.runpod/deploy/production-plan.json`) and
after step 7 (which exports `CLOUD_RUN_CANDIDATE_EVIDENCE_PATH`) that runs
`pnpm run environment:policy:export production` with step env
`SCRIBE_DROP_PRODUCTION_GPU_EXECUTION_POLICY: cloud_run_jobs_l4_v1` and
`SCRIBE_DROP_PRODUCTION_GPU_EXECUTION_ADMISSION: active` (job env already has
`SCRIBE_DROP_PRODUCTION_CLOUD_RUN_RUNTIME_MODE: active`). The promote step
now supplies the exported `EXPECTED_ENVIRONMENT_POLICY_ID`. Note the
cutover job env does NOT define
`SCRIBE_DROP_PRODUCTION_GPU_EXECUTION_POLICY`/`..._ADMISSION` at job level
(step-level only), so the export step needs explicit step env; the finalize
job defines the policy at job level.

The complete preflight now (a) statically detects a
consumer of `EXPECTED_ENVIRONMENT_POLICY_ID` with no in-job producer, and
(b) computes the normalized production policy ID locally (render +
export with the same inputs) and compare it against the staging evidence's
`environmentPolicyId` — this both validates parity and pre-validates the
proposed fix.

### Other confirmed facts

- `parseMinimumAcceptanceRemainingMilliseconds` (release-acceptance.mjs:237)
  returns `undefined` for undefined input; the cutover step 7 passes
  `MINIMUM_ACCEPTANCE_REMAINING_SECONDS=2700` without a policy ID (check
  skipped there).
- `export-staging-acceptance-identity.mjs` exports only
  `CANDIDATE_RUN_ID`, `CLOUD_RUN_CANDIDATE_RUN_ID`, `CANDIDATE_COMMIT_SHA`
  (no policy ID) — it cannot serve as the producer.
- `render-cloudflare-production-config.mjs:25-26` writes the CORS/lifecycle
  files; `render-runpod-environment-config.mjs:52` writes
  `.runpod/deploy/production-plan.json`.
- Production workflow history (last 4 relevant): `2ac12f1` added the
  mutation-free preflight, `9ae290b` moved candidate-identity export to a
  separate step, `bbfaa8c` fixed the absent-Service controller preflight.
  No commit added a cutover policy export.
- `verify-staging-acceptance.mjs` is the only other consumer; finalize is
  consistent with it (export at :666 before the verify call).

### Latest production cutover result

- GPU-free staging recovery `32314247491` and mutation-free production
  preflight `32314590987` succeeded on workflow commit `ae938a2`; the formal
  preflight verifier confirmed every mutation step was skipped.
- Cutover `32314997150` passed all preflight checks, migrations/R2 policy, and
  RunPod image promotion, then stopped before application deploy, provider
  switching, authorization, or GPU execution. Cloud Run returned 404 while
  creating the previously absent production controller Service.
- Cloud Audit Logs gave the exact cause: PATCH with `allowMissing=true` cannot
  create an absent Service when `updateMask` is present. A subsequent
  CreateService validate-only call showed that the create body must also omit
  `service.name`.
- The current uncommitted fix uses name-free CreateService POST for an absent
  Service, PATCH only for an existing Service, and performs the same POST with
  `validateOnly=true` plus an absence read-back during preflight. The exact
  production plan passed this live validate-only path with 13 read requests and
  `serviceMutationObserved=false`; the Service remains absent.
- That fix was committed as `c401494`. GPU-free staging recovery `32315737420`
  succeeded, but production preflight `32315945525` failed safely during the
  new CreateService validate-only call. Audit Logs showed the workflow identity
  lacks `run.services.setIamPolicy`, which is required by
  `invokerIamDisabled`. All mutation/GPU steps were skipped. The current
  uncommitted change adds exactly that permission to the shared release
  deployer custom role and fixes the full Service create/update/read-back
  permission set in a regression test. External IAM has not yet been changed.
