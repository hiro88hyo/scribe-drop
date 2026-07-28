import assert from "node:assert/strict";
import test from "node:test";

import {
  requiredProductionSecretNames,
  requiredProductionVariableNames,
  verifyProductionGithubControls,
} from "./production-github-controls.mjs";

function controls() {
  return {
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
    secretNames: [...requiredProductionSecretNames],
    variableNames: [...requiredProductionVariableNames],
    workflowPath: ".github/workflows/deploy-production-candidate.yml",
  };
}

test("accepts exact fail-fast production controls without reading values", () => {
  assert.deepEqual(verifyProductionGithubControls(controls()), {
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
