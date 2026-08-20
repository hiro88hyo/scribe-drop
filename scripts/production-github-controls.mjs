import { verifyBranchProtections } from "./github-branch-protection.mjs";
export { requiredProductionVariableNames } from "./production-environment-contract.mjs";
import { requiredProductionVariableNames } from "./production-environment-contract.mjs";

const workflowPath = ".github/workflows/deploy-production-candidate.yml";

export const requiredProductionSecretNames = [
  "CLOUDFLARE_API_TOKEN",
  "CLOUDFLARE_PAGES_API_TOKEN",
  "RUNPOD_API_KEY",
  "SCRIBE_DROP_PRODUCTION_CLOUD_RUN_CONTROLLER_HMAC_PRIMARY",
  "SCRIBE_DROP_PRODUCTION_CLOUD_RUN_RUNTIME_DERIVATION_SECRET",
  "SCRIBE_DROP_PRODUCTION_RUNPOD_ENDPOINT_ID",
];

function requireRecord(value, name) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${name} is invalid`);
  }
  return value;
}

function requireArray(value, name) {
  if (!Array.isArray(value)) {
    throw new Error(`${name} is invalid`);
  }
  return value;
}

function requireString(value, name) {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${name} is invalid`);
  }
  return value;
}

function requireExactNames(value, expected, name) {
  const names = requireArray(value, name).map((entry) => requireString(entry, name));
  const sortedExpected = [...expected].sort();
  if (
    new Set(names).size !== names.length ||
    names.length !== expected.length ||
    [...names].sort().some((entry, index) => entry !== sortedExpected[index])
  ) {
    throw new Error(`${name} does not match the reviewed set`);
  }
  return names;
}

export function verifyProductionGithubControls(untrustedInput) {
  const input = requireRecord(untrustedInput, "Production GitHub controls");
  const failures = [];
  if (input.defaultBranch !== "develop") {
    failures.push("GitHub default branch must be develop");
  }
  if (input.workflowPath !== workflowPath) {
    failures.push("Production workflow is not registered on the default branch");
  }
  let branchProtectionCount = 0;
  try {
    const result = verifyBranchProtections(input.branchProtections, input.releaseBranch);
    branchProtectionCount = result.branchProtectionCount;
  } catch (error) {
    failures.push(error instanceof Error ? error.message : "GitHub branch protections are invalid");
  }

  try {
    const environment = requireRecord(input.environment, "Production GitHub Environment");
    if (environment.name !== "production") {
      failures.push("Production GitHub Environment is invalid");
    }
    const protectionRules = requireArray(
      environment.protection_rules,
      "Production Environment protection rules",
    ).map((rule) => requireRecord(rule, "Production Environment protection rule"));
    const reviewerRules = protectionRules.filter((rule) => rule.type === "required_reviewers");
    if (
      reviewerRules.length !== 1 ||
      requireArray(reviewerRules[0].reviewers, "Production Environment required reviewers").length <
        1
    ) {
      failures.push("Production Environment requires at least one reviewer");
    }
    if (protectionRules.filter((rule) => rule.type === "branch_policy").length !== 1) {
      failures.push("Production Environment branch protection is invalid");
    }
    const deploymentBranchPolicy = requireRecord(
      environment.deployment_branch_policy,
      "Production Environment deployment branch policy",
    );
    if (
      deploymentBranchPolicy.protected_branches !== false ||
      deploymentBranchPolicy.custom_branch_policies !== true
    ) {
      failures.push("Production Environment must use custom branch policies only");
    }
  } catch (error) {
    failures.push(
      error instanceof Error ? error.message : "Production GitHub Environment is invalid",
    );
  }

  let variableCount = 0;
  let secretCount = 0;
  for (const [value, expected, name, recordCount] of [
    [input.branchPolicyNames, ["release/*"], "Production Environment branch policies", undefined],
    [
      input.variableNames,
      requiredProductionVariableNames,
      "Production Environment variables",
      (count) => {
        variableCount = count;
      },
    ],
    [
      input.secretNames,
      requiredProductionSecretNames,
      "Production Environment secrets",
      (count) => {
        secretCount = count;
      },
    ],
  ]) {
    try {
      const names = requireExactNames(value, expected, name);
      recordCount?.(names.length);
    } catch (error) {
      failures.push(error instanceof Error ? error.message : `${name} is invalid`);
    }
  }

  if (failures.length > 0) {
    throw new Error([...new Set(failures)].join("; "));
  }

  return {
    branchProtectionCount,
    secretCount,
    variableCount,
  };
}
