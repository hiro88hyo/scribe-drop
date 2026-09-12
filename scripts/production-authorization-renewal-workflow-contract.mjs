const requiredJobFragments = [
  "if: inputs.operation == 'renew'",
  "environment: production",
  "contents: read",
  "id-token: write",
  "actions/checkout@de0fac2e4500dabe0009e67214ff5f5447ce83dd",
  "volta-cli/action@615a78f6c83e116339c53b94f3f82b4d6c0b7d18",
  "google-github-actions/auth@7c6bc770dae815cd3e89ee6cdf493a5fab2cc093",
  "google-github-actions/setup-gcloud@aa5489c8933f4cc7a4f7d45035b3b1440c9c10db",
  "actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a",
  "workloadIdentityPools/scribe-drop-release/providers/github-production-deployment",
  "service_account: sd-production-deployer@scribe-drop.iam.gserviceaccount.com",
  "version: 579.0.0",
  "EXPECTED_CONTROLLER_IMAGE_DIGEST: ${{ inputs.expected_controller_image_digest }}",
  "PREVIOUS_PRODUCTION_AUTHORIZATION_EPOCH: ${{ inputs.previous_authorization_epoch }}",
  "PREVIOUS_PRODUCTION_AUTHORIZATION_MAX_EXECUTIONS: ${{ inputs.previous_authorization_max_executions }}",
  "PREVIOUS_PRODUCTION_AUTHORIZATION_VALID_UNTIL: ${{ inputs.previous_authorization_valid_until }}",
  "PRODUCTION_AUTHORIZATION_MAX_EXECUTIONS: ${{ inputs.operational_max_executions }}",
  "PRODUCTION_AUTHORIZATION_MAX_WORST_CASE_JPY: ${{ inputs.operational_max_worst_case_jpy }}",
  "PRODUCTION_AUTHORIZATION_VALID_UNTIL: ${{ inputs.operational_valid_until }}",
];

const orderedSteps = [
  "Validate source-managed renewal workflow contract",
  "pnpm run production:authorization:renewal:workflow:verify",
  "Validate bounded renewal inputs before external access",
  "pnpm run production:authorization:renewal inputs",
  "Authenticate isolated production deployer",
  "Set up pinned Google Cloud CLI",
  "Read back the complete resumable renewal prefix",
  "pnpm run production:authorization:renewal preflight",
  "Apply only the controller Service authorization",
  "pnpm run production:authorization:renewal apply-service",
  "Apply only the conditional Firestore authorization",
  "pnpm run production:authorization:renewal apply-firestore",
  "Verify converged production authorization",
  "pnpm run production:authorization:renewal verify",
  "Record bounded production authorization evidence",
  "pnpm run production:authorization:renewal evidence production-authorization-renewal/evidence.json",
  "Upload production authorization evidence",
];

function requireOnce(text, fragment, label) {
  const first = text.indexOf(fragment);
  if (first < 0 || text.indexOf(fragment, first + fragment.length) >= 0) {
    throw new Error(`${label} must occur exactly once`);
  }
}

export function verifyProductionAuthorizationRenewalWorkflow(workflow) {
  if (typeof workflow !== "string") throw new Error("Production workflow source is invalid");
  const jobStart = workflow.indexOf("\n  renew-authorization:\n");
  if (jobStart < 0) throw new Error("Production authorization renewal job is missing");
  const job = workflow.slice(jobStart);

  for (const fragment of [
    "- renew",
    "group: scribe-drop-production-promotion",
    "cancel-in-progress: false",
    "verify-promotion:\n    name: Verify immutable candidate, acceptance, and operation inputs\n    if: inputs.operation != 'renew'",
  ]) {
    if (!workflow.includes(fragment)) {
      throw new Error(`Production workflow is missing ${fragment}`);
    }
  }
  for (const fragment of requiredJobFragments) {
    if (!job.includes(fragment)) throw new Error(`Renewal job is missing ${fragment}`);
  }
  for (const fragment of [
    "continue-on-error:",
    "docker ",
    "candidate:create",
    "candidate:application:create",
    "staging:acceptance",
    "runpod:",
    "wrangler ",
  ]) {
    if (job.toLowerCase().includes(fragment)) {
      throw new Error(`Renewal job contains forbidden operation ${fragment}`);
    }
  }

  let cursor = -1;
  for (const fragment of orderedSteps) {
    requireOnce(job, fragment, fragment);
    const next = job.indexOf(fragment);
    if (next <= cursor) throw new Error(`Renewal workflow order is invalid at ${fragment}`);
    cursor = next;
  }
  requireOnce(
    job,
    "pnpm run production:authorization:renewal apply-service",
    "Controller Service mutation",
  );
  requireOnce(
    job,
    "pnpm run production:authorization:renewal apply-firestore",
    "Firestore mutation",
  );
  if (
    (
      job.match(
        /GOOGLE_OAUTH_ACCESS_TOKEN: \$\{\{ steps\.google-auth\.outputs\.access_token \}\}/gu,
      ) ?? []
    ).length !== 5
  ) {
    throw new Error("Every renewal remote read or mutation must use the isolated access token");
  }
}

export function verifyProductionAuthorizationRenewalManager(manager) {
  if (typeof manager !== "string") throw new Error("Production renewal manager source is invalid");
  const required = [
    'spawnSync("gcloud", arguments_',
    '"run",\n      "services",\n      "describe"',
    '"run", "jobs", "list"',
    '"run", "jobs", "executions", "list"',
    '"run",\n    "services",\n    "update"',
    'parameters.append("updateMask.fieldPaths", field)',
    'parameters.set("currentDocument.updateTime", patch.updateTime)',
    '{ body: JSON.stringify(patch.body), method: "PATCH" }',
    'if (snapshot.stage !== "active") requireNoExistingGpuLifecycle()',
    'if (before.stage !== "service-updated" || before.document.activeExecutions !== 0)',
    'if (after.stage !== "active")',
  ];
  for (const fragment of required) {
    if (!manager.includes(fragment)) throw new Error(`Renewal manager is missing ${fragment}`);
  }
  for (const fragment of [
    "shell: true",
    "execSync(",
    "execFileSync(",
    "docker ",
    "wrangler ",
    "runpodctl",
  ]) {
    if (manager.toLowerCase().includes(fragment.toLowerCase())) {
      throw new Error(`Renewal manager contains forbidden operation ${fragment}`);
    }
  }
  requireOnce(
    manager,
    'gcloud([\n    "run",\n    "services",\n    "update"',
    "gcloud Service update",
  );
  requireOnce(manager, 'method: "PATCH"', "Firestore PATCH");
}
