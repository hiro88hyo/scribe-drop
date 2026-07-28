export const requiredStatusCheckNames = [
  "Browser E2E",
  "Dependency audit",
  "Quality gate",
  "RunPod container supply chain",
  "Secret scan",
];

const releaseBranchPattern = /^release\/(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)$/u;

function requireRecord(value, name) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${name} is invalid`);
  }
  return value;
}

function requireReleaseBranch(value) {
  if (typeof value !== "string" || !releaseBranchPattern.test(value)) {
    throw new Error("Release branch is invalid");
  }
  return value;
}

function enabled(value) {
  return requireRecord(value, "Branch protection control").enabled === true;
}

export function createBranchProtectionRequest(branchInput) {
  const isLongLivedBranch = branchInput === "main" || branchInput === "develop";
  if (!isLongLivedBranch) {
    requireReleaseBranch(branchInput);
  }
  return {
    allow_deletions: false,
    allow_force_pushes: false,
    allow_fork_syncing: false,
    block_creations: false,
    enforce_admins: true,
    lock_branch: false,
    required_conversation_resolution: isLongLivedBranch,
    required_linear_history: false,
    required_pull_request_reviews: isLongLivedBranch
      ? {
          dismiss_stale_reviews: true,
          require_code_owner_reviews: false,
          require_last_push_approval: true,
          required_approving_review_count: 1,
        }
      : null,
    required_status_checks: isLongLivedBranch
      ? {
          contexts: [...requiredStatusCheckNames],
          strict: true,
        }
      : null,
    restrictions: null,
  };
}

function verifyLongLivedBranchProtection(branch, protection) {
  const statusChecks = requireRecord(
    protection.required_status_checks,
    `${branch} required status checks`,
  );
  const checkNames = Array.isArray(statusChecks.checks)
    ? statusChecks.checks.map((check) => requireRecord(check, `${branch} required check`).context)
    : [];
  const sortedCheckNames = checkNames.map(String).sort();
  if (
    statusChecks.strict !== true ||
    sortedCheckNames.length !== requiredStatusCheckNames.length ||
    sortedCheckNames.some((name, index) => name !== requiredStatusCheckNames[index])
  ) {
    throw new Error(`${branch} required status checks do not match`);
  }
  const reviews = requireRecord(
    protection.required_pull_request_reviews,
    `${branch} pull request reviews`,
  );
  if (
    reviews.dismiss_stale_reviews !== true ||
    reviews.require_code_owner_reviews !== false ||
    reviews.require_last_push_approval !== true ||
    reviews.required_approving_review_count !== 1
  ) {
    throw new Error(`${branch} pull request review policy does not match`);
  }
  if (!enabled(protection.required_conversation_resolution)) {
    throw new Error(`${branch} must require conversation resolution`);
  }
}

function verifyReleaseBranchProtection(branch, protection) {
  if (
    (protection.required_status_checks ?? null) !== null ||
    (protection.required_pull_request_reviews ?? null) !== null ||
    enabled(protection.required_conversation_resolution)
  ) {
    throw new Error(`${branch} release maintenance policy does not match`);
  }
}

export function verifyBranchProtections(untrustedProtections, releaseBranchInput) {
  const releaseBranch = requireReleaseBranch(releaseBranchInput);
  const protections = requireRecord(untrustedProtections, "GitHub branch protections");
  const expectedBranches = ["develop", "main", releaseBranch].sort();
  const actualBranches = Object.keys(protections).sort();
  if (
    actualBranches.length !== expectedBranches.length ||
    actualBranches.some((branch, index) => branch !== expectedBranches[index])
  ) {
    throw new Error("GitHub branch protection targets do not match");
  }

  for (const branch of expectedBranches) {
    const protection = requireRecord(protections[branch], `${branch} branch protection`);
    if (
      !enabled(protection.enforce_admins) ||
      enabled(protection.allow_force_pushes) ||
      enabled(protection.allow_deletions) ||
      enabled(protection.required_linear_history) ||
      enabled(protection.lock_branch)
    ) {
      throw new Error(`${branch} shared branch controls do not match`);
    }
    if (branch === "main" || branch === "develop") {
      verifyLongLivedBranchProtection(branch, protection);
    } else {
      verifyReleaseBranchProtection(branch, protection);
    }
  }
  return { branchProtectionCount: expectedBranches.length };
}
