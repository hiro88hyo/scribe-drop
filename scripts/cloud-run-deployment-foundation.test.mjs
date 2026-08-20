import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  createCloudRunDeploymentFoundationPlan,
  createFirestoreTtlUpdateArguments,
  createStandardFirestoreDatabaseArguments,
  deploymentRolePermissions,
  stagingBootstrapPreflightRolePermissions,
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

test("uses only Standard Edition Firestore creation flags", () => {
  const database = createCloudRunDeploymentFoundationPlan().controller.database;
  const arguments_ = createStandardFirestoreDatabaseArguments(database);
  assert.deepEqual(arguments_, [
    "firestore",
    "databases",
    "create",
    "--database=scribe-production-controller",
    "--location=asia-southeast1",
    "--type=firestore-native",
    "--edition=standard",
    "--concurrency-mode=pessimistic",
    "--delete-protection",
    "--enable-pitr",
  ]);
  assert.equal(
    arguments_.some((argument) => argument.includes("data-access")),
    false,
  );
  assert.equal(
    arguments_.some((argument) => argument.includes("realtime")),
    false,
  );
});

test("submits Firestore TTL updates asynchronously for explicit convergence polling", () => {
  const database = createCloudRunDeploymentFoundationPlan().controller.database;
  assert.deepEqual(
    createFirestoreTtlUpdateArguments(database, "scribe_drop_controller_executions"),
    [
      "firestore",
      "fields",
      "ttls",
      "update",
      "ttlExpiresAt",
      "--collection-group=scribe_drop_controller_executions",
      "--database=scribe-production-controller",
      "--enable-ttl",
      "--expiration-offset=0s",
      "--async",
    ],
  );
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
  assert.equal(deploymentRolePermissions.includes("datastore.databases.get"), true);
  assert.equal(deploymentRolePermissions.includes("datastore.databases.getMetadata"), true);
});

test("grants every Cloud Run Service permission required by create, update, and read-back", () => {
  for (const permission of [
    "run.operations.get",
    "run.services.create",
    "run.services.get",
    "run.services.getIamPolicy",
    "run.services.setIamPolicy",
    "run.services.update",
  ]) {
    assert.equal(deploymentRolePermissions.includes(permission), true, permission);
  }
});

test("converges only the shared release deployer role through its targeted command", () => {
  const managerSource = readFileSync(
    new URL("./manage-cloud-run-deployment-foundation.mjs", import.meta.url),
    "utf8",
  );
  const body = managerSource.match(/function applyReleaseDeployerRole\(\) \{(?<body>[\s\S]*?)\n\}/u)
    ?.groups?.body;
  assert.equal(typeof body, "string");
  assert.match(
    body,
    /ensureCustomRole\(plan\.deploymentRole, "deployment", \{ updateExisting: true \}\)/u,
  );
  assert.match(body, /verify-cloud-run-deployment-foundation\.mjs", "staging"/u);
  assert.doesNotMatch(
    body,
    /rotatePrimarySecret|ensureDatabase|addProjectBinding|addServiceAccountBinding/u,
  );

  const packageJson = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  assert.equal(
    packageJson.scripts["cloud-run:foundation:apply:release-deployer-role"],
    "node scripts/manage-cloud-run-deployment-foundation.mjs apply-release-deployer-role --confirm-release-deployer-role",
  );
});

test("isolates GPU-free bootstrap mutation to a staging-only role", () => {
  const plan = createCloudRunDeploymentFoundationPlan();
  assert.equal(plan.stagingBootstrapPreflightService, "cloudquotas.googleapis.com");
  assert.equal(
    plan.stagingBootstrapPreflightRole.name,
    "projects/scribe-drop/roles/scribeDropStagingBootstrapPreflight",
  );
  assert.deepEqual(stagingBootstrapPreflightRolePermissions, [
    "cloudquotas.quotas.get",
    "logging.logEntries.list",
    "run.executions.get",
    "run.executions.list",
    "run.jobs.create",
    "run.jobs.delete",
    "run.jobs.get",
    "run.jobs.list",
    "run.jobs.run",
    "run.operations.get",
    "serviceusage.services.list",
  ]);
  assert.equal(new Set(stagingBootstrapPreflightRolePermissions).size, 11);
  assert.equal(
    stagingBootstrapPreflightRolePermissions.includes("run.jobs.runWithOverrides"),
    false,
  );
  assert.equal(stagingBootstrapPreflightRolePermissions.includes("run.services.update"), false);
  assert.equal(
    stagingBootstrapPreflightRolePermissions.includes("cloudquotas.quotas.update"),
    false,
  );
  assert.equal(
    stagingBootstrapPreflightRolePermissions.includes("serviceusage.services.enable"),
    false,
  );
  assert.equal(deploymentRolePermissions.includes("run.jobs.create"), false);
});

test("enables and verifies the exact Cloud Quotas API before staging preflight", () => {
  const managerSource = readFileSync(
    new URL("./manage-cloud-run-deployment-foundation.mjs", import.meta.url),
    "utf8",
  );
  const verifierSource = readFileSync(
    new URL("./verify-cloud-run-deployment-foundation.mjs", import.meta.url),
    "utf8",
  );
  assert.match(managerSource, /ensureServiceEnabled\(plan\.stagingBootstrapPreflightService\)/u);
  assert.match(managerSource, /\["services", "enable", service\]/u);
  assert.match(verifierSource, /requireServiceEnabled\(plan\.stagingBootstrapPreflightService\)/u);
  assert.match(verifierSource, /observed\[0\]\?\.state !== "ENABLED"/u);
});

test("grants the staging bootstrap deployer read-only access to the worker repository", () => {
  const managerSource = readFileSync(
    new URL("./manage-cloud-run-deployment-foundation.mjs", import.meta.url),
    "utf8",
  );
  const binding = managerSource.match(
    /function addStagingBootstrapWorkerRepositoryBinding\(\) \{(?<body>[\s\S]*?)\n\}/u,
  )?.groups?.body;
  assert.equal(typeof binding, "string");
  assert.match(binding, /"worker"/u);
  assert.match(binding, /--role=roles\/artifactregistry\.reader/u);
  assert.match(binding, /stagingIdentity\.account\.email/u);

  const verifierSource = readFileSync(
    new URL("./verify-cloud-run-deployment-foundation.mjs", import.meta.url),
    "utf8",
  );
  assert.match(verifierSource, /"staging bootstrap worker repository"/u);
  assert.match(verifierSource, /\[\{ role: "roles\/artifactregistry\.reader" \}\]/u);
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
