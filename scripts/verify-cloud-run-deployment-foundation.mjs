import { existsSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";

import { createCloudRunDeploymentFoundationPlan } from "./cloud-run-deployment-foundation.mjs";

const plan = createCloudRunDeploymentFoundationPlan();
const localGcloud = path.resolve(".tools/bin/gcloud");
const gcloud = existsSync(localGcloud) ? localGcloud : "gcloud";
const gcloudEnvironment = {
  ...process.env,
  ...(existsSync(localGcloud) ? { CLOUDSDK_CONFIG: path.resolve(".tools/gcloud-config") } : {}),
};

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, canonical(item)]),
    );
  }
  return value;
}

function same(left, right) {
  return JSON.stringify(canonical(left)) === JSON.stringify(canonical(right));
}

function requireRecord(value, label) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} is invalid`);
  }
  return value;
}

function gcloudJson(arguments_, label) {
  const result = spawnSync(
    gcloud,
    [...arguments_, `--project=${plan.projectId}`, "--quiet", "--format=json"],
    {
      encoding: "utf8",
      env: gcloudEnvironment,
      maxBuffer: 2 * 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 60_000,
    },
  );
  if (result.error !== undefined || result.status !== 0) throw new Error(`${label} failed`);
  try {
    return JSON.parse(result.stdout);
  } catch {
    throw new Error(`${label} returned invalid JSON`);
  }
}

function requireServiceAccount(account) {
  const observed = requireRecord(
    gcloudJson(
      ["iam", "service-accounts", "describe", account.email],
      `${account.id} service account read`,
    ),
    `${account.id} service account`,
  );
  if (
    observed.email !== account.email ||
    observed.displayName !== account.displayName ||
    observed.description !== account.description ||
    observed.disabled === true
  ) {
    throw new Error(`${account.id} service account does not match the reviewed plan`);
  }
}

function requireRole(role) {
  const observed = requireRecord(
    gcloudJson(["iam", "roles", "describe", role.id], `${role.id} role read`),
    `${role.id} role`,
  );
  const observedPermissions = Array.isArray(observed.includedPermissions)
    ? [...observed.includedPermissions].sort()
    : [];
  if (
    observed.name !== role.name ||
    observed.title !== role.title ||
    observed.description !== role.description ||
    observed.stage !== role.stage ||
    observed.deleted === true ||
    !same(observedPermissions, [...role.permissions].sort())
  ) {
    throw new Error(`${role.id} role does not match the reviewed plan`);
  }
}

function requireProvider(identity) {
  const observed = requireRecord(
    gcloudJson(
      [
        "iam",
        "workload-identity-pools",
        "providers",
        "describe",
        identity.provider.id,
        "--location=global",
        "--workload-identity-pool=scribe-drop-release",
      ],
      `${identity.environment} deployment provider read`,
    ),
    `${identity.environment} deployment provider`,
  );
  if (
    observed.name !== identity.provider.name ||
    observed.displayName !== identity.provider.displayName ||
    observed.description !== identity.provider.description ||
    observed.disabled === true ||
    observed.attributeCondition !== identity.provider.attributeCondition ||
    observed.oidc?.issuerUri !== identity.provider.oidcIssuer ||
    !same(observed.attributeMapping, identity.provider.attributeMapping)
  ) {
    throw new Error(`${identity.environment} deployment provider does not match the reviewed plan`);
  }
}

function principalBindings(policy, member) {
  const record = requireRecord(policy, "IAM policy");
  if (!Array.isArray(record.bindings)) throw new Error("IAM policy bindings are invalid");
  return record.bindings
    .filter((binding) => Array.isArray(binding?.members) && binding.members.includes(member))
    .map((binding) => ({
      ...(binding.condition === undefined ? {} : { condition: canonical(binding.condition) }),
      role: binding.role,
    }))
    .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
}

function requirePrincipalBindings(arguments_, member, expected, label) {
  const policy = gcloudJson(arguments_, `${label} IAM policy read`);
  const sortedExpected = [...expected].sort((left, right) =>
    JSON.stringify(left).localeCompare(JSON.stringify(right)),
  );
  if (!same(principalBindings(policy, member), sortedExpected)) {
    throw new Error(`${label} IAM bindings do not match the reviewed plan`);
  }
}

function requireIdentity(identity) {
  requireServiceAccount(identity.account);
  requireProvider(identity);
  requirePrincipalBindings(
    ["iam", "service-accounts", "get-iam-policy", identity.account.email],
    identity.principal,
    [{ role: "roles/iam.workloadIdentityUser" }],
    `${identity.environment} deployment service account`,
  );
  requirePrincipalBindings(
    ["projects", "get-iam-policy", plan.projectId],
    `serviceAccount:${identity.account.email}`,
    [
      { role: plan.deploymentRole.name },
      ...(identity.environment === "staging"
        ? [{ role: plan.stagingBootstrapPreflightRole.name }]
        : []),
    ],
    `${identity.environment} deployment project`,
  );
  requirePrincipalBindings(
    ["artifacts", "repositories", "get-iam-policy", "controller", "--location=asia-southeast1"],
    `serviceAccount:${identity.account.email}`,
    [{ role: "roles/artifactregistry.reader" }],
    `${identity.environment} controller repository`,
  );
}

function requireStagingBootstrapPreflight(identity) {
  requireRole(plan.stagingBootstrapPreflightRole);
  requirePrincipalBindings(
    [
      "iam",
      "service-accounts",
      "get-iam-policy",
      "gpu-controller@scribe-drop.iam.gserviceaccount.com",
    ],
    `serviceAccount:${identity.account.email}`,
    [{ role: "roles/iam.serviceAccountUser" }],
    "staging controller service account",
  );
  requirePrincipalBindings(
    [
      "iam",
      "service-accounts",
      "get-iam-policy",
      "gpu-runtime@scribe-drop.iam.gserviceaccount.com",
    ],
    `serviceAccount:${identity.account.email}`,
    [{ role: "roles/iam.serviceAccountUser" }],
    "staging runtime service account",
  );
  requirePrincipalBindings(
    ["artifacts", "repositories", "get-iam-policy", "worker", "--location=asia-southeast1"],
    `serviceAccount:${identity.account.email}`,
    [{ role: "roles/artifactregistry.reader" }],
    "staging bootstrap worker repository",
  );
}

function requireProductionController(identity) {
  const controller = plan.controller;
  requireServiceAccount(controller.account);
  requireServiceAccount(controller.runtimeAccount);
  for (const role of plan.existingControllerRoles) requireRole(role);
  requirePrincipalBindings(
    ["iam", "service-accounts", "get-iam-policy", controller.account.email],
    `serviceAccount:${identity.account.email}`,
    [{ role: "roles/iam.serviceAccountUser" }],
    "production controller service account",
  );
  const controllerPrincipal = `serviceAccount:${controller.account.email}`;
  requirePrincipalBindings(
    ["projects", "get-iam-policy", plan.projectId],
    controllerPrincipal,
    [
      { role: `projects/${plan.projectId}/roles/scribeDropCloudRunController` },
      {
        condition: {
          description: "Restricts controller transactions to its environment database.",
          expression: `resource.name == "projects/${plan.projectId}/databases/${controller.database.id}"`,
          title: "ScribeDrop production Firestore database",
        },
        role: `projects/${plan.projectId}/roles/scribeDropFirestoreController`,
      },
    ],
    "production controller project",
  );
  requirePrincipalBindings(
    ["artifacts", "repositories", "get-iam-policy", "worker", "--location=asia-southeast1"],
    controllerPrincipal,
    [{ role: "roles/artifactregistry.reader" }],
    "production worker repository",
  );
  requirePrincipalBindings(
    ["iam", "service-accounts", "get-iam-policy", controller.runtimeAccount.email],
    controllerPrincipal,
    [{ role: "roles/iam.serviceAccountUser" }],
    "production runtime service account",
  );
  requirePrincipalBindings(
    ["projects", "get-iam-policy", plan.projectId],
    `serviceAccount:${controller.runtimeAccount.email}`,
    [],
    "production runtime project",
  );

  const database = requireRecord(
    gcloudJson(
      ["firestore", "databases", "describe", `--database=${controller.database.id}`],
      "production controller database read",
    ),
    "production controller database",
  );
  if (
    database.name !== `projects/${plan.projectId}/databases/${controller.database.id}` ||
    database.locationId !== controller.database.location ||
    database.type !== "FIRESTORE_NATIVE" ||
    database.databaseEdition !== "STANDARD" ||
    database.concurrencyMode !== "PESSIMISTIC" ||
    database.deleteProtectionState !== "DELETE_PROTECTION_ENABLED" ||
    database.pointInTimeRecoveryEnablement !== "POINT_IN_TIME_RECOVERY_ENABLED"
  ) {
    throw new Error("Production controller database does not match the reviewed plan");
  }
  const ttlFields = gcloudJson(
    ["firestore", "fields", "ttls", "list", `--database=${controller.database.id}`],
    "production controller TTL read",
  );
  if (!Array.isArray(ttlFields)) throw new Error("Production controller TTL read is invalid");
  const expectedTtlNames = controller.database.ttlCollectionGroups
    .map(
      (collection) =>
        `projects/${plan.projectId}/databases/${controller.database.id}/collectionGroups/${collection}/fields/ttlExpiresAt`,
    )
    .sort();
  const observedTtlNames = ttlFields
    .filter((field) => field?.ttlConfig?.state === "ACTIVE")
    .map((field) => field.name)
    .sort();
  if (!same(observedTtlNames, expectedTtlNames)) {
    throw new Error("Production controller TTL policies do not match the reviewed plan");
  }

  const secret = requireRecord(
    gcloudJson(["secrets", "describe", controller.primarySecret.id], "production secret read"),
    "production secret",
  );
  if (
    secret.name !== `projects/${plan.projectNumber}/secrets/${controller.primarySecret.id}` ||
    !same(secret.labels, controller.primarySecret.labels) ||
    Object.keys(secret.annotations ?? {}).length !== 0 ||
    Object.keys(secret.versionAliases ?? {}).length !== 0 ||
    !same(secret.replication?.userManaged?.replicas?.map(({ location }) => location).sort(), [
      controller.primarySecret.location,
    ])
  ) {
    throw new Error("Production controller secret does not match the reviewed plan");
  }
  requirePrincipalBindings(
    ["secrets", "get-iam-policy", controller.primarySecret.id],
    controllerPrincipal,
    [{ role: "roles/secretmanager.secretAccessor" }],
    "production controller secret",
  );
  const version = process.env.SCRIBE_DROP_PRODUCTION_CLOUD_RUN_CONTROLLER_HMAC_SECRET_VERSION;
  if (typeof version !== "string" || !/^[1-9][0-9]*$/u.test(version)) {
    throw new Error("Production controller secret version is missing or invalid");
  }
  const observedVersion = requireRecord(
    gcloudJson(
      ["secrets", "versions", "describe", version, `--secret=${controller.primarySecret.id}`],
      "production secret version read",
    ),
    "production secret version",
  );
  if (
    observedVersion.name !==
      `projects/${plan.projectNumber}/secrets/${controller.primarySecret.id}/versions/${version}` ||
    observedVersion.state !== "ENABLED"
  ) {
    throw new Error("Production controller secret version does not match the reviewed plan");
  }
}

const [environment] = process.argv.slice(2);
if (!new Set(["staging", "production"]).has(environment) || process.argv.length !== 3) {
  throw new Error("Usage: verify-cloud-run-deployment-foundation <staging|production>");
}

try {
  requireRole(plan.deploymentRole);
  const identity = plan.identities.find((candidate) => candidate.environment === environment);
  if (identity === undefined) throw new Error("Deployment identity is missing from the plan");
  requireIdentity(identity);
  if (environment === "staging") requireStagingBootstrapPreflight(identity);
  if (environment === "production") requireProductionController(identity);
  console.log(
    JSON.stringify({
      controller: environment === "production" ? "verified" : "existing-staging",
      environment,
      workloadIdentity: "verified",
    }),
  );
} catch (error) {
  console.error(
    error instanceof Error ? error.message : "Cloud Run foundation verification failed",
  );
  process.exitCode = 1;
}
