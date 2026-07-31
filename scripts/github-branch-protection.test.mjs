import assert from "node:assert/strict";
import test from "node:test";

import {
  createBranchProtectionRequest,
  requiredStatusCheckNames,
  verifyBranchProtections,
} from "./github-branch-protection.mjs";

const releaseBranch = "release/0.1.0";

function control(enabled) {
  return { enabled };
}

function protection(branch) {
  const longLived = branch === "main" || branch === "develop";
  const result = {
    allow_deletions: control(false),
    allow_force_pushes: control(false),
    enforce_admins: control(true),
    lock_branch: control(false),
    required_conversation_resolution: control(longLived),
    required_linear_history: control(false),
  };
  if (longLived) {
    result.required_pull_request_reviews = {
      dismiss_stale_reviews: true,
      require_code_owner_reviews: false,
      require_last_push_approval: true,
      required_approving_review_count: 1,
    };
    result.required_status_checks = {
      checks: requiredStatusCheckNames.map((context) => ({ context })),
      strict: true,
    };
  }
  return result;
}

function protections() {
  return {
    develop: protection("develop"),
    main: protection("main"),
    [releaseBranch]: protection(releaseBranch),
  };
}

test("creates strict long-lived and maintainable release requests", () => {
  const develop = createBranchProtectionRequest("develop");
  assert.deepEqual(develop.required_status_checks, {
    contexts: requiredStatusCheckNames,
    strict: true,
  });
  assert.equal(develop.required_pull_request_reviews.required_approving_review_count, 1);
  assert.equal(develop.required_pull_request_reviews.require_last_push_approval, true);
  assert.equal(develop.required_conversation_resolution, true);

  const release = createBranchProtectionRequest(releaseBranch);
  assert.equal(release.required_status_checks, null);
  assert.equal(release.required_pull_request_reviews, null);
  assert.equal(release.required_conversation_resolution, false);
  assert.equal(release.enforce_admins, true);
  assert.equal(release.allow_force_pushes, false);
  assert.equal(release.allow_deletions, false);
});

test("accepts exact main, develop, and release branch protections", () => {
  assert.deepEqual(verifyBranchProtections(protections(), releaseBranch), {
    branchProtectionCount: 3,
  });
});

test("rejects missing checks, review weakening, and release lockout", () => {
  const missingCheck = protections();
  missingCheck.main.required_status_checks.checks.pop();
  assert.throws(
    () => verifyBranchProtections(missingCheck, releaseBranch),
    /required status checks/u,
  );

  const weakReview = protections();
  weakReview.develop.required_pull_request_reviews.require_last_push_approval = false;
  assert.throws(() => verifyBranchProtections(weakReview, releaseBranch), /review policy/u);

  const lockedRelease = protections();
  lockedRelease[releaseBranch].required_pull_request_reviews = {
    required_approving_review_count: 1,
  };
  assert.throws(
    () => verifyBranchProtections(lockedRelease, releaseBranch),
    /release maintenance policy/u,
  );
});
