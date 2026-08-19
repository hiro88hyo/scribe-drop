import { requiredProductionSecretNames } from "./production-github-controls.mjs";
import { requiredProductionVariableNames } from "./production-environment-contract.mjs";

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
  const end = source.indexOf("\n      - name:", start + 1);
  return source.slice(start, end === -1 ? source.length : end);
}

export function verifyProductionWorkflowStateContract(source) {
  const producerName = "Verify accepted production environment policy before external access";
  requireOrdered(source, [
    "Render disabled preflight configuration",
    producerName,
    "Verify every external control plane before production mutation",
    "Promote exact rollback-compatible RunPod image without execution",
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
  return {
    policyProducer: producerName,
    secretReferences: requireExactReferences(source, "secrets", requiredProductionSecretNames),
    variableReferences: requireExactReferences(source, "vars", requiredProductionVariableNames),
  };
}
