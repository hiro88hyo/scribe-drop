import assert from "node:assert/strict";
import test from "node:test";

import {
  requiredProductionSecretNames,
  requiredProductionVariableNames,
  verifyProductionGithubControls,
} from "./production-github-controls.mjs";
import { requiredStatusCheckNames } from "./github-branch-protection.mjs";

const releaseBranch = "release/0.1.0";

function branchProtection(branch) {
  const longLived = branch === "main" || branch === "develop";
  return {
    allow_deletions: { enabled: false },
    allow_force_pushes: { enabled: false },
    enforce_admins: { enabled: true },
    lock_branch: { enabled: false },
    required_conversation_resolution: { enabled: longLived },
    required_linear_history: { enabled: false },
    required_pull_request_reviews: longLived
      ? {
          dismiss_stale_reviews: true,
          require_code_owner_reviews: false,
          require_last_push_approval: true,
          required_approving_review_count: 1,
        }
      : null,
    required_status_checks: longLived
      ? {
          checks: requiredStatusCheckNames.map((context) => ({ context })),
          strict: true,
        }
      : null,
  };
}

function controls() {
  return {
    branchProtections: {
      develop: branchProtection("develop"),
      main: branchProtection("main"),
      [releaseBranch]: branchProtection(releaseBranch),
    },
    branchPolicyNames: ["release/*"],
    defaultBranch: "develop",
    environment: {
      deployment_branch_policy: {
        custom_branch_policies: true,
        protected_branches: false,
      },
      name: "production",
      protection_rules: [
        {
          reviewers: [{ type: "User" }],
          type: "required_reviewers",
        },
        {
          type: "branch_policy",
        },
      ],
    },
    releaseBranch,
    secretNames: [...requiredProductionSecretNames],
    variableNames: [...requiredProductionVariableNames],
    workflowPath: ".github/workflows/deploy-production-candidate.yml",
  };
}

test("accepts exact fail-fast production controls without reading values", () => {
  assert.deepEqual(verifyProductionGithubControls(controls()), {
    branchProtectionCount: 3,
    secretCount: 4,
    variableCount: 15,
  });
});

test("rejects an unregistered workflow and incomplete credentials", () => {
  const incomplete = controls();
  incomplete.workflowPath = null;
  incomplete.variableNames.pop();
  incomplete.secretNames.push("LEGACY_TOKEN");
  assert.throws(
    () => verifyProductionGithubControls(incomplete),
    (error) =>
      error instanceof Error &&
      /workflow is not registered/u.test(error.message) &&
      /variables does not match/u.test(error.message) &&
      /secrets does not match/u.test(error.message),
  );
});

test("rejects missing review and broader deployment branches", () => {
  const missingReview = controls();
  missingReview.environment.protection_rules[0].reviewers = [];
  assert.throws(() => verifyProductionGithubControls(missingReview), /at least one reviewer/u);

  const broadBranch = controls();
  broadBranch.branchPolicyNames = ["*"];
  assert.throws(
    () => verifyProductionGithubControls(broadBranch),
    /branch policies does not match/u,
  );
});

test("rejects missing repository branch protection with other controls intact", () => {
  const unprotected = controls();
  delete unprotected.branchProtections.main;
  assert.throws(
    () => verifyProductionGithubControls(unprotected),
    /branch protection targets do not match/u,
  );
});
