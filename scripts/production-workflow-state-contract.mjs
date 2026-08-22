import { requiredProductionSecretNames } from "./production-github-controls.mjs";
import { requiredProductionVariableNames } from "./production-environment-contract.mjs";
import { productionFinalizeStages } from "./production-finalize-state.mjs";

function exactReferences(source, kind) {
  return [
    ...new Set(
      [...source.matchAll(new RegExp(`\\$\\{\\{ ${kind}\\.([A-Z][A-Z0-9_]*) \\}\\}`, "gu"))].map(
        (match) => match[1],
      ),
    ),
  ].sort();
}

function requireExactReferences(source, kind, expected) {
  const observed = exactReferences(source, kind);
  const sortedExpected = [...expected].sort();
  if (
    observed.length !== sortedExpected.length ||
    observed.some((name, index) => name !== sortedExpected[index])
  ) {
    throw new Error(`Production workflow ${kind} references do not match the reviewed set`);
  }
  return observed.length;
}

function requireOrdered(source, names) {
  let previous = -1;
  for (const name of names) {
    const index = source.indexOf(`- name: ${name}`);
    if (index === -1 || index <= previous) {
      throw new Error(`Production cutover step is missing or out of order: ${name}`);
    }
    previous = index;
  }
}

function stepBlock(source, name) {
  const start = source.indexOf(`- name: ${name}`);
  if (start === -1) throw new Error(`Production workflow step is missing: ${name}`);
  const end = source.indexOf("\n      - name:", start + 1);
  return source.slice(start, end === -1 ? source.length : end);
}

function requireStepValues(source, name, values) {
  const step = stepBlock(source, name);
  for (const value of values) {
    if (!step.includes(value)) {
      throw new Error(`Production workflow step ${name} is incomplete: ${value}`);
    }
  }
  return step;
}

export function verifyProductionWorkflowStateContract(source) {
  const producerName = "Verify accepted production environment policy before external access";
  requireOrdered(source, [
    "Verify previous production release entry before cutover",
    "Render disabled preflight configuration",
    producerName,
    "Verify every external control plane before production mutation",
    "Promote exact rollback-compatible RunPod image without execution",
  ]);
  requireOrdered(source, [
    "Promote exact rollback-compatible RunPod image without execution",
    "Deploy exact application candidate with admission paused",
    "Drain old provider before changing new-attempt selection",
    "Quiesce the expired previous production authorization",
    "Deploy bounded controller after admission drain",
    "Select Cloud Run while keeping admission paused",
    "Verify exact-one L4 authorization and activate admission",
  ]);
  const producer = stepBlock(source, producerName);
  for (const required of [
    "          STAGING_RUN_ID: ${{ inputs.staging_run_id }}",
    "SCRIBE_DROP_PRODUCTION_GPU_EXECUTION_ADMISSION: active",
    "SCRIBE_DROP_PRODUCTION_GPU_EXECUTION_POLICY: cloud_run_jobs_l4_v1",
    "pnpm run environment:policy:export production",
    'EXPECTED_CANDIDATE_RUN_ID="${CANDIDATE_RUN_ID}"',
    'EXPECTED_CLOUD_RUN_CANDIDATE_RUN_ID="${CLOUD_RUN_CANDIDATE_RUN_ID}"',
    'EXPECTED_STAGING_RUN_ID="${STAGING_RUN_ID}"',
    "pnpm run staging:acceptance:verify",
  ]) {
    if (!producer.includes(required)) {
      throw new Error(`Production environment policy producer is incomplete: ${required}`);
    }
  }
  const externalPreflight = stepBlock(
    source,
    "Verify every external control plane before production mutation",
  );
  let previousCommand = -1;
  for (const command of [
    "pnpm run cloudflare:worker-route:verify:production",
    "pnpm run cloudflare:pages:upload-permission:verify:production",
    "pnpm run cloudflare:secrets:verify:production:pages",
    "pnpm run cloudflare:access:verify:production",
    "pnpm run runpod:preflight:production",
    'CLOUDFLARE_API_TOKEN="${CLOUDFLARE_PAGES_API_TOKEN}" \\\n            pnpm exec wrangler pages deployment list',
    'test -s "${RUNNER_TEMP}/pages-deployment-preflight.json"',
  ]) {
    const index = externalPreflight.indexOf(command);
    if (index === -1 || index <= previousCommand) {
      throw new Error(`Production external preflight is incomplete or out of order: ${command}`);
    }
    previousCommand = index;
  }
  const promotionStart = source.indexOf(
    "- name: Promote exact rollback-compatible RunPod image without execution",
  );
  const promotionEnd = source.indexOf("\n      - name:", promotionStart + 1);
  const promotion = source.slice(
    promotionStart,
    promotionEnd === -1 ? source.length : promotionEnd,
  );
  if (!promotion.includes("pnpm run runpod:promote:production")) {
    throw new Error("Production RunPod promotion consumer is missing");
  }
  for (const stage of productionFinalizeStages) {
    if (!source.includes(`          - ${stage}`)) {
      throw new Error(`Production finalize input omits state: ${stage}`);
    }
  }
  const finalizeSteps = [
    "Verify exact finalize entry state before mutation",
    "Pause admission before changing authorization",
    "Disable the consumed smoke authorization",
    "Apply reviewed finite operating authorization",
    "Activate admission after exact operational authorization",
    "Verify final parity, Access, and accepted artifact identity",
    "Record immutable production release evidence",
  ];
  requireOrdered(source, finalizeSteps);
  requireStepValues(source, "Validate bounded production operation inputs", [
    "PRODUCTION_FINALIZE_ENTRY_STAGE: ${{ inputs.finalize_entry_stage }}",
    "PREVIOUS_PRODUCTION_RUN_ID: ${{ inputs.previous_production_run_id }}",
    "pnpm run production:promotion:inputs:verify",
  ]);
  requireStepValues(source, "Verify previous production release entry before cutover", [
    "if: inputs.operation == 'cutover'",
    "PREVIOUS_PRODUCTION_RUN_ID: ${{ inputs.previous_production_run_id }}",
    "pnpm run --silent production:upgrade:entry resolve",
    "pnpm run --silent production:upgrade:entry export",
  ]);
  requireStepValues(source, "Export verified previous production upgrade entry", [
    "PREVIOUS_PRODUCTION_RUN_ID: ${{ inputs.previous_production_run_id }}",
    "pnpm run --silent production:upgrade:entry resolve",
    "pnpm run --silent production:upgrade:entry export",
    '>>"${GITHUB_ENV}"',
  ]);
  requireStepValues(source, "Deploy exact application candidate with admission paused", [
    "SCRIBE_DROP_PRODUCTION_GPU_EXECUTION_ADMISSION: paused",
    "SCRIBE_DROP_PRODUCTION_GPU_EXECUTION_POLICY: cloud_run_jobs_l4_v1",
    "pnpm run cloudflare:readback:production",
  ]);
  requireStepValues(source, "Quiesce the expired previous production authorization", [
    "GOOGLE_OAUTH_ACCESS_TOKEN:",
    "pnpm run cloud-run:controller:deploy quiesce production disabled",
  ]);
  requireStepValues(source, "Deploy bounded controller after admission drain", [
    "GOOGLE_OAUTH_ACCESS_TOKEN:",
    "pnpm run cloud-run:controller:deploy apply production smoke",
  ]);
  requireStepValues(source, finalizeSteps[0], [
    "GOOGLE_OAUTH_ACCESS_TOKEN:",
    "SCRIBE_DROP_CLOUD_RUN_SMOKE_EPOCH: phase16-smoke-${{ inputs.candidate_commit_sha }}-${{ inputs.cutover_run_id }}",
    "SCRIBE_DROP_CLOUD_RUN_OPERATIONAL_EPOCH: phase16-operational-${{ inputs.candidate_commit_sha }}-${{ inputs.cutover_run_id }}",
    "SCRIBE_DROP_CLOUD_RUN_AUTHORIZATION_VALID_UNTIL: ${{ inputs.operational_valid_until }}",
    "SCRIBE_DROP_CLOUD_RUN_MAX_EXECUTIONS: ${{ inputs.operational_max_executions }}",
    "SCRIBE_DROP_CLOUD_RUN_MAX_WORST_CASE_JPY: ${{ inputs.operational_max_worst_case_jpy }}",
    "PRODUCTION_SMOKE_JOB_ID: ${{ inputs.production_smoke_job_id }}",
    "SCRIBE_DROP_PRODUCTION_GPU_EXECUTION_ADMISSION: ${{ (inputs.finalize_entry_stage == 'smoke-active' || inputs.finalize_entry_stage == 'operational-active') && 'active' || 'paused' }}",
    "pnpm run cloud-run:production:smoke:verify",
    "pnpm run production:finalize:entry:verify",
    '"${{ inputs.finalize_entry_stage }}" "${CUTOVER_RUN_PATH}"',
  ]);
  requireStepValues(source, finalizeSteps[1], [
    "if: inputs.finalize_entry_stage == 'smoke-active'",
    "SCRIBE_DROP_PRODUCTION_GPU_EXECUTION_ADMISSION: paused",
    "pnpm exec wrangler deploy",
    "pnpm run cloudflare:readback:production",
  ]);
  requireStepValues(source, finalizeSteps[2], [
    "if: inputs.finalize_entry_stage == 'smoke-active' || inputs.finalize_entry_stage == 'smoke-paused'",
    "GOOGLE_OAUTH_ACCESS_TOKEN:",
    "SCRIBE_DROP_CLOUD_RUN_EXPECTED_AUTHORIZATION_EPOCH: phase16-smoke-${{ inputs.candidate_commit_sha }}-${{ inputs.cutover_run_id }}",
    'SCRIBE_DROP_CLOUD_RUN_EXPECTED_RESERVED_EXECUTIONS: "1"',
    "pnpm run cloud-run:controller:deploy apply production disabled",
  ]);
  requireStepValues(source, finalizeSteps[3], [
    "if: inputs.finalize_entry_stage != 'operational-paused' && inputs.finalize_entry_stage != 'operational-active'",
    "GOOGLE_OAUTH_ACCESS_TOKEN:",
    "SCRIBE_DROP_CLOUD_RUN_AUTHORIZATION_EPOCH: phase16-operational-${{ inputs.candidate_commit_sha }}-${{ inputs.cutover_run_id }}",
    "SCRIBE_DROP_CLOUD_RUN_AUTHORIZATION_VALID_UNTIL: ${{ inputs.operational_valid_until }}",
    "SCRIBE_DROP_CLOUD_RUN_MAX_EXECUTIONS: ${{ inputs.operational_max_executions }}",
    "SCRIBE_DROP_CLOUD_RUN_MAX_WORST_CASE_JPY: ${{ inputs.operational_max_worst_case_jpy }}",
    "pnpm run cloud-run:controller:deploy apply production operational",
  ]);
  requireStepValues(source, finalizeSteps[4], [
    "if: inputs.finalize_entry_stage != 'operational-active'",
    "SCRIBE_DROP_PRODUCTION_GPU_EXECUTION_ADMISSION: active",
    "pnpm exec wrangler deploy",
    "pnpm run cloudflare:readback:production",
  ]);
  requireStepValues(source, finalizeSteps[5], [
    "GOOGLE_OAUTH_ACCESS_TOKEN:",
    "SCRIBE_DROP_CLOUD_RUN_AUTHORIZATION_EPOCH: phase16-operational-${{ inputs.candidate_commit_sha }}-${{ inputs.cutover_run_id }}",
    "SCRIBE_DROP_CLOUD_RUN_AUTHORIZATION_VALID_UNTIL: ${{ inputs.operational_valid_until }}",
    "SCRIBE_DROP_CLOUD_RUN_MAX_EXECUTIONS: ${{ inputs.operational_max_executions }}",
    "SCRIBE_DROP_CLOUD_RUN_MAX_WORST_CASE_JPY: ${{ inputs.operational_max_worst_case_jpy }}",
    "SCRIBE_DROP_PRODUCTION_GPU_EXECUTION_ADMISSION: active",
    "pnpm run cloud-run:controller:deploy read production operational",
    "pnpm run environment:policy:export production",
    "pnpm run staging:acceptance:verify",
    "pnpm run cloudflare:access:verify:production",
    "pnpm run cloudflare:secrets:verify:production",
  ]);
  requireStepValues(source, finalizeSteps[6], [
    "FINALIZE_ENTRY_STAGE: ${{ inputs.finalize_entry_stage }}",
    "pnpm run production:release:evidence create production-release",
  ]);
  if (
    source.includes("phase16-operational-${{ inputs.candidate_commit_sha }}-${{ github.run_id }}")
  ) {
    throw new Error("Production operational epoch must be stable across finalize retries");
  }
  return {
    cutoverMutationCount: 8,
    finalizeMutationCount: 4,
    finalizePrefixStateCount: productionFinalizeStages.length,
    policyProducer: producerName,
    secretReferences: requireExactReferences(source, "secrets", requiredProductionSecretNames),
    variableReferences: requireExactReferences(source, "vars", requiredProductionVariableNames),
  };
}
