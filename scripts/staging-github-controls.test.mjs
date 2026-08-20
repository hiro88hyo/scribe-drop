import assert from "node:assert/strict";
import test from "node:test";

import { requiredStatusCheckNames } from "./github-branch-protection.mjs";
import {
  requiredStagingSecretNames,
  requiredStagingVariableNames,
  verifyStagingGithubControls,
} from "./staging-github-controls.mjs";

const releaseBranch = "release/0.2.0";

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
          require_last_push_approval: false,
          required_approving_review_count: 0,
        }
      : null,
    required_status_checks: longLived
      ? { checks: requiredStatusCheckNames.map((context) => ({ context })), strict: true }
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
      deployment_branch_policy: { custom_branch_policies: true, protected_branches: false },
      name: "staging",
      protection_rules: [{ type: "branch_policy" }],
    },
    releaseBranch,
    secretNames: [...requiredStagingSecretNames],
    variableNames: [...requiredStagingVariableNames],
    workflowPath: ".github/workflows/deploy-staging-candidate.yml",
  };
}

test("accepts the exact staging Environment contract", () => {
  assert.deepEqual(verifyStagingGithubControls(controls()), {
    branchProtectionCount: 3,
    secretCount: 6,
    variableCount: 20,
  });
});

test("rejects missing variables, extra secrets, reviewers, and broad branches", () => {
  const incomplete = controls();
  incomplete.variableNames.pop();
  incomplete.secretNames.push("LEGACY_SECRET");
  assert.throws(
    () => verifyStagingGithubControls(incomplete),
    (error) =>
      error instanceof Error &&
      /variables does not match/u.test(error.message) &&
      /secrets does not match/u.test(error.message),
  );
  const reviewed = controls();
  reviewed.environment.protection_rules.unshift({
    reviewers: [{ type: "User" }],
    type: "required_reviewers",
  });
  assert.throws(() => verifyStagingGithubControls(reviewed), /protection does not match/u);
  const broad = controls();
  broad.branchPolicyNames = ["*"];
  assert.throws(() => verifyStagingGithubControls(broad), /branch policies does not match/u);
});
