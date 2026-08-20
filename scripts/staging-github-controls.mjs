import { verifyBranchProtections } from "./github-branch-protection.mjs";

const workflowPath = ".github/workflows/deploy-staging-candidate.yml";

export const requiredStagingVariableNames = [
  "AUDIT_RETENTION_DAYS",
  "CLOUDFLARE_ACCOUNT_ID",
  "MULTIPART_RETENTION_HOURS",
  "RESULT_RETENTION_DAYS",
  "SCRIBE_DROP_STAGING_ACCESS_AUDIENCE",
  "SCRIBE_DROP_STAGING_ACCESS_TEAM_DOMAIN",
  "SCRIBE_DROP_STAGING_CLOUD_RUN_CONTROLLER_HMAC_SECRET_VERSION",
  "SCRIBE_DROP_STAGING_CLOUD_RUN_CONTROLLER_ORIGIN",
  "SCRIBE_DROP_STAGING_CLOUD_RUN_RUNTIME_SERVICE_ACCOUNT",
  "SCRIBE_DROP_STAGING_D1_DATABASE_ID",
  "SCRIBE_DROP_STAGING_E2E_SERVICE_TOKEN_COMMON_NAME",
  "SCRIBE_DROP_STAGING_ORCHESTRATOR_ORIGIN",
  "SCRIBE_DROP_STAGING_PAGES_ACCESS_AUDIENCE",
  "SCRIBE_DROP_STAGING_PAGES_PROJECT",
  "SCRIBE_DROP_STAGING_R2_HOST",
  "SCRIBE_DROP_STAGING_RUNPOD_GPU_IDS",
  "SCRIBE_DROP_STAGING_RUNPOD_IMAGE_VISIBILITY",
  "SCRIBE_DROP_STAGING_RUNPOD_REGISTRY_AUTH_ID",
  "SCRIBE_DROP_STAGING_WEB_ORIGIN",
  "SOURCE_RETENTION_DAYS",
];

export const requiredStagingSecretNames = [
  "CF_ACCESS_CLIENT_ID",
  "CF_ACCESS_CLIENT_SECRET",
  "CLOUDFLARE_API_TOKEN",
  "CLOUDFLARE_PAGES_API_TOKEN",
  "RUNPOD_API_KEY",
  "SCRIBE_DROP_STAGING_RUNPOD_ENDPOINT_ID",
];

function requireRecord(value, name) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${name} is invalid`);
  }
  return value;
}

function requireArray(value, name) {
  if (!Array.isArray(value)) throw new Error(`${name} is invalid`);
  return value;
}

function requireExactNames(value, expected, name) {
  const names = requireArray(value, name).map((entry) => {
    if (typeof entry !== "string" || entry.length === 0) throw new Error(`${name} is invalid`);
    return entry;
  });
  const sortedExpected = [...expected].sort();
  if (
    names.length !== expected.length ||
    new Set(names).size !== names.length ||
    [...names].sort().some((entry, index) => entry !== sortedExpected[index])
  ) {
    throw new Error(`${name} does not match the reviewed set`);
  }
  return names.length;
}

export function verifyStagingGithubControls(untrustedInput) {
  const input = requireRecord(untrustedInput, "Staging GitHub controls");
  const failures = [];
  if (input.defaultBranch !== "develop") failures.push("GitHub default branch must be develop");
  if (input.workflowPath !== workflowPath) {
    failures.push("Staging workflow is not registered on the default branch");
  }
  let branchProtectionCount = 0;
  try {
    branchProtectionCount = verifyBranchProtections(
      input.branchProtections,
      input.releaseBranch,
    ).branchProtectionCount;
  } catch (error) {
    failures.push(error instanceof Error ? error.message : "GitHub branch protections are invalid");
  }
  try {
    const environment = requireRecord(input.environment, "Staging GitHub Environment");
    const rules = requireArray(
      environment.protection_rules,
      "Staging Environment protection rules",
    ).map((rule) => requireRecord(rule, "Staging Environment protection rule"));
    const deploymentBranchPolicy = requireRecord(
      environment.deployment_branch_policy,
      "Staging Environment deployment branch policy",
    );
    if (
      environment.name !== "staging" ||
      rules.length !== 1 ||
      rules[0]?.type !== "branch_policy" ||
      deploymentBranchPolicy.protected_branches !== false ||
      deploymentBranchPolicy.custom_branch_policies !== true
    ) {
      failures.push("Staging GitHub Environment protection does not match the reviewed boundary");
    }
  } catch (error) {
    failures.push(error instanceof Error ? error.message : "Staging GitHub Environment is invalid");
  }
  let variableCount = 0;
  let secretCount = 0;
  for (const [value, expected, name, record] of [
    [input.branchPolicyNames, ["release/*"], "Staging Environment branch policies", undefined],
    [
      input.variableNames,
      requiredStagingVariableNames,
      "Staging Environment variables",
      (count) => {
        variableCount = count;
      },
    ],
    [
      input.secretNames,
      requiredStagingSecretNames,
      "Staging Environment secrets",
      (count) => {
        secretCount = count;
      },
    ],
  ]) {
    try {
      const count = requireExactNames(value, expected, name);
      record?.(count);
    } catch (error) {
      failures.push(error instanceof Error ? error.message : `${name} is invalid`);
    }
  }
  if (failures.length > 0) throw new Error([...new Set(failures)].join("; "));
  return { branchProtectionCount, secretCount, variableCount };
}
