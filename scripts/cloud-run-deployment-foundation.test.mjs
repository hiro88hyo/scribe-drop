import assert from "node:assert/strict";
import test from "node:test";

import {
  createCloudRunDeploymentFoundationPlan,
  deploymentRolePermissions,
} from "./cloud-run-deployment-foundation.mjs";

test("isolates exact staging and production deployment subjects", () => {
  const plan = createCloudRunDeploymentFoundationPlan();
  assert.deepEqual(
    plan.identities.map(({ environment, provider }) => [environment, provider.id]),
    [
      ["staging", "github-staging-deployment"],
      ["production", "github-production-deployment"],
    ],
  );
  for (const identity of plan.identities) {
    assert.match(
      identity.provider.attributeCondition,
      new RegExp(`environment:${identity.environment}`, "u"),
    );
    assert.match(identity.provider.attributeCondition, /assertion\.repository_id == '1312444559'/u);
    assert.match(
      identity.provider.attributeCondition,
      /assertion\.event_name == 'workflow_dispatch'/u,
    );
    assert.match(identity.provider.attributeCondition, /refs\/heads\/release\//u);
    assert.match(identity.provider.attributeCondition, new RegExp(identity.workflowPath, "u"));
  }
  assert.notEqual(plan.identities[0].account.email, plan.identities[1].account.email);
});

test("fixes the isolated production controller foundation", () => {
  const plan = createCloudRunDeploymentFoundationPlan();
  assert.deepEqual(plan.controller.database, {
    id: "scribe-production-controller",
    location: "asia-southeast1",
    pitr: true,
    ttlCollectionGroups: ["scribe_drop_controller_executions", "scribe_drop_controller_requests"],
  });
  assert.equal(plan.controller.account.email.includes("production"), true);
  assert.equal(plan.controller.runtimeAccount.email.includes("production"), true);
  assert.equal(plan.controller.primarySecret.location, "asia-southeast1");
  assert.deepEqual(plan.controller.primarySecret.labels, {
    "scribe-drop-component": "gpu-controller",
    "scribe-drop-environment": "production",
  });
});

test("keeps deployment role mutation and secret payload access out of scope", () => {
  assert.equal(new Set(deploymentRolePermissions).size, deploymentRolePermissions.length);
  assert.equal(
    deploymentRolePermissions.every((permission) => permission === permission.trim()),
    true,
  );
  assert.equal(deploymentRolePermissions.includes("secretmanager.versions.access"), false);
  assert.equal(deploymentRolePermissions.includes("iam.serviceAccounts.setIamPolicy"), false);
  assert.equal(deploymentRolePermissions.includes("resourcemanager.projects.setIamPolicy"), false);
  assert.equal(deploymentRolePermissions.includes("run.jobs.create"), false);
  assert.equal(deploymentRolePermissions.includes("run.jobs.run"), false);
  assert.equal(deploymentRolePermissions.includes("iam.workloadIdentityPoolProviders.get"), true);
});

test("reuses only the already reviewed controller roles", () => {
  const plan = createCloudRunDeploymentFoundationPlan();
  assert.deepEqual(
    plan.existingControllerRoles.map(({ id }) => id),
    ["scribeDropCloudRunController", "scribeDropFirestoreController"],
  );
  assert.equal(
    plan.existingControllerRoles.some(({ permissions }) =>
      permissions.includes("run.jobs.runWithOverrides"),
    ),
    false,
  );
});
