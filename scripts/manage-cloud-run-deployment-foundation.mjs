import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";

import {
  createCloudRunDeploymentFoundationPlan,
  createStandardFirestoreDatabaseArguments,
} from "./cloud-run-deployment-foundation.mjs";

const plan = createCloudRunDeploymentFoundationPlan();
const localGcloud = path.resolve(".tools/bin/gcloud");
const gcloud = existsSync(localGcloud) ? localGcloud : "gcloud";
const gcloudEnvironment = {
  ...process.env,
  ...(existsSync(localGcloud) ? { CLOUDSDK_CONFIG: path.resolve(".tools/gcloud-config") } : {}),
};

function run(command, arguments_, { environment, input, label, optional = false } = {}) {
  const result = spawnSync(command, arguments_, {
    encoding: "utf8",
    env: environment ?? (command === gcloud ? gcloudEnvironment : process.env),
    input,
    maxBuffer: 2 * 1024 * 1024,
    stdio: ["pipe", "pipe", "pipe"],
    timeout: 5 * 60 * 1_000,
  });
  if (result.error !== undefined || (!optional && result.status !== 0)) {
    throw new Error(`${label ?? command} failed`);
  }
  return result;
}

function gcloudRun(arguments_, options = {}) {
  return run(gcloud, [...arguments_, `--project=${plan.projectId}`, "--quiet"], options);
}

function readJson(arguments_, label) {
  const result = gcloudRun([...arguments_, "--format=json"], { label, optional: true });
  if (result.status !== 0) {
    if (/NOT_FOUND|not found|does not exist|was not found|404/iu.test(result.stderr)) {
      return undefined;
    }
    throw new Error(`${label} failed`);
  }
  try {
    const parsed = JSON.parse(result.stdout);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new Error("not an object");
    }
    return parsed;
  } catch {
    throw new Error(`${label} returned invalid JSON`);
  }
}

function canonicalRecord(value) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  return Object.fromEntries(
    Object.entries(value).sort(([left], [right]) => left.localeCompare(right)),
  );
}

function ensureServiceAccount(account) {
  let observed = readJson(
    ["iam", "service-accounts", "describe", account.email],
    `${account.id} service account read`,
  );
  if (observed === undefined) {
    gcloudRun(
      [
        "iam",
        "service-accounts",
        "create",
        account.id,
        `--description=${account.description}`,
        `--display-name=${account.displayName}`,
      ],
      { label: `${account.id} service account creation` },
    );
    observed = readJson(
      ["iam", "service-accounts", "describe", account.email],
      `${account.id} service account read`,
    );
  }
  if (
    observed?.email !== account.email ||
    observed?.displayName !== account.displayName ||
    observed?.description !== account.description ||
    observed?.disabled === true
  ) {
    throw new Error(`${account.id} service account does not match the reviewed plan`);
  }
}

function ensureProvider(identity) {
  const common = [
    "iam",
    "workload-identity-pools",
    "providers",
    "describe",
    identity.provider.id,
    "--location=global",
    "--workload-identity-pool=scribe-drop-release",
  ];
  let observed = readJson(common, `${identity.environment} deployment provider read`);
  if (observed === undefined) {
    gcloudRun(
      [
        "iam",
        "workload-identity-pools",
        "providers",
        "create-oidc",
        identity.provider.id,
        "--location=global",
        "--workload-identity-pool=scribe-drop-release",
        `--display-name=${identity.provider.displayName}`,
        `--description=${identity.provider.description}`,
        "--attribute-mapping=google.subject=assertion.sub,attribute.repository_id=assertion.repository_id,attribute.repository_owner_id=assertion.repository_owner_id",
        `--attribute-condition=${identity.provider.attributeCondition}`,
        `--issuer-uri=${identity.provider.oidcIssuer}`,
      ],
      { label: `${identity.environment} deployment provider creation` },
    );
    observed = readJson(common, `${identity.environment} deployment provider read`);
  }
  const expectedMapping = identity.provider.attributeMapping;
  if (
    observed?.name !== identity.provider.name ||
    observed?.displayName !== identity.provider.displayName ||
    observed?.description !== identity.provider.description ||
    observed?.disabled === true ||
    observed?.attributeCondition !== identity.provider.attributeCondition ||
    observed?.oidc?.issuerUri !== identity.provider.oidcIssuer ||
    JSON.stringify(canonicalRecord(observed?.attributeMapping)) !==
      JSON.stringify(canonicalRecord(expectedMapping))
  ) {
    throw new Error(`${identity.environment} deployment provider does not match the reviewed plan`);
  }
}

function ensureDeploymentRole() {
  const role = plan.deploymentRole;
  let observed = readJson(["iam", "roles", "describe", role.id], "deployment role read");
  if (observed === undefined) {
    gcloudRun(
      [
        "iam",
        "roles",
        "create",
        role.id,
        `--title=${role.title}`,
        `--description=${role.description}`,
        `--permissions=${role.permissions.join(",")}`,
        `--stage=${role.stage}`,
      ],
      { label: "deployment role creation" },
    );
    observed = readJson(["iam", "roles", "describe", role.id], "deployment role read");
  }
  const permissions = Array.isArray(observed?.includedPermissions)
    ? [...observed.includedPermissions].sort()
    : [];
  if (
    observed?.name !== role.name ||
    observed?.title !== role.title ||
    observed?.description !== role.description ||
    observed?.stage !== role.stage ||
    JSON.stringify(permissions) !== JSON.stringify([...role.permissions].sort())
  ) {
    throw new Error("Deployment role does not match the reviewed plan");
  }
}

function addServiceAccountBinding(accountEmail, member, role) {
  gcloudRun(
    [
      "iam",
      "service-accounts",
      "add-iam-policy-binding",
      accountEmail,
      `--member=${member}`,
      `--role=${role}`,
      "--condition=None",
    ],
    { label: `IAM binding on ${accountEmail}` },
  );
}

function addProjectBinding(member, role, condition) {
  gcloudRun(
    [
      "projects",
      "add-iam-policy-binding",
      plan.projectId,
      `--member=${member}`,
      `--role=${role}`,
      `--condition=${condition ?? "None"}`,
    ],
    { label: `project IAM binding for ${role}` },
  );
}

function ensureDatabase() {
  const database = plan.controller.database;
  const readArguments = ["firestore", "databases", "describe", `--database=${database.id}`];
  if (readJson(readArguments, "production controller database read") === undefined) {
    gcloudRun(createStandardFirestoreDatabaseArguments(database), {
      label: "production controller database creation",
    });
  }
  for (const collectionGroup of database.ttlCollectionGroups) {
    gcloudRun(
      [
        "firestore",
        "fields",
        "ttls",
        "update",
        "ttlExpiresAt",
        `--collection-group=${collectionGroup}`,
        `--database=${database.id}`,
        "--enable-ttl",
        "--expiration-offset=0s",
      ],
      { label: `TTL policy for ${collectionGroup}` },
    );
  }
}

function addControllerBindings() {
  const controller = plan.controller;
  const controllerPrincipal = `serviceAccount:${controller.account.email}`;
  addProjectBinding(
    controllerPrincipal,
    `projects/${plan.projectId}/roles/scribeDropCloudRunController`,
  );
  addProjectBinding(
    controllerPrincipal,
    `projects/${plan.projectId}/roles/scribeDropFirestoreController`,
    "^:^title=ScribeDrop production Firestore database" +
      ":description=Restricts controller transactions to its environment database." +
      `:expression=resource.name == "projects/${plan.projectId}/databases/${controller.database.id}"`,
  );
  gcloudRun(
    [
      "artifacts",
      "repositories",
      "add-iam-policy-binding",
      "worker",
      "--location=asia-southeast1",
      `--member=${controllerPrincipal}`,
      "--role=roles/artifactregistry.reader",
      "--condition=None",
    ],
    { label: "production controller worker repository binding" },
  );
  addServiceAccountBinding(
    controller.runtimeAccount.email,
    controllerPrincipal,
    "roles/iam.serviceAccountUser",
  );
}

function addDeploymentArtifactBindings() {
  for (const identity of plan.identities) {
    gcloudRun(
      [
        "artifacts",
        "repositories",
        "add-iam-policy-binding",
        "controller",
        "--location=asia-southeast1",
        `--member=serviceAccount:${identity.account.email}`,
        "--role=roles/artifactregistry.reader",
        "--condition=None",
      ],
      { label: `${identity.environment} deployment controller repository binding` },
    );
  }
}

function rotatePrimarySecret() {
  const secret = plan.controller.primarySecret;
  const value = randomBytes(32).toString("base64url");
  const describe = readJson(["secrets", "describe", secret.id], "production primary secret read");
  if (
    describe !== undefined &&
    (describe.name !== `projects/${plan.projectNumber}/secrets/${secret.id}` ||
      JSON.stringify(canonicalRecord(describe.labels)) !==
        JSON.stringify(canonicalRecord(secret.labels)) ||
      JSON.stringify(describe.replication?.userManaged?.replicas) !==
        JSON.stringify([{ location: secret.location }]) ||
      Object.keys(describe.annotations ?? {}).length !== 0 ||
      Object.keys(describe.versionAliases ?? {}).length !== 0)
  ) {
    throw new Error("Production primary secret does not match the reviewed plan");
  }
  const result =
    describe === undefined
      ? gcloudRun(
          [
            "secrets",
            "create",
            secret.id,
            "--data-file=-",
            "--replication-policy=user-managed",
            `--locations=${secret.location}`,
            `--labels=${Object.entries(secret.labels)
              .map(([key, labelValue]) => `${key}=${labelValue}`)
              .join(",")}`,
            "--format=value(name)",
          ],
          { input: value, label: "production primary secret creation" },
        )
      : gcloudRun(
          ["secrets", "versions", "add", secret.id, "--data-file=-", "--format=value(name)"],
          { input: value, label: "production primary secret rotation" },
        );
  let version;
  if (describe === undefined) {
    const latest = gcloudRun(
      [
        "secrets",
        "versions",
        "list",
        secret.id,
        "--filter=state:enabled",
        "--sort-by=~createTime",
        "--limit=1",
        "--format=value(name)",
      ],
      { label: "production primary secret version read" },
    );
    version = latest.stdout.trim().split("/").at(-1);
  } else {
    version = result.stdout.trim().split("/").at(-1);
  }
  if (version === undefined || !/^[1-9][0-9]*$/u.test(version)) {
    throw new Error("Production primary secret version is invalid");
  }
  const controllerPrincipal = `serviceAccount:${plan.controller.account.email}`;
  gcloudRun(
    [
      "secrets",
      "add-iam-policy-binding",
      secret.id,
      `--member=${controllerPrincipal}`,
      "--role=roles/secretmanager.secretAccessor",
      "--condition=None",
    ],
    { label: "production primary secret accessor binding" },
  );
  run(
    "gh",
    [
      "secret",
      "set",
      "SCRIBE_DROP_PRODUCTION_CLOUD_RUN_CONTROLLER_HMAC_PRIMARY",
      "--env",
      "production",
    ],
    {
      input: value,
      label: "production controller Worker secret registration",
    },
  );
  run(
    "gh",
    [
      "secret",
      "set",
      "SCRIBE_DROP_PRODUCTION_CLOUD_RUN_RUNTIME_DERIVATION_SECRET",
      "--env",
      "production",
    ],
    {
      input: randomBytes(32).toString("base64url"),
      label: "production runtime derivation secret registration",
    },
  );
  run(
    "gh",
    [
      "variable",
      "set",
      "SCRIBE_DROP_PRODUCTION_CLOUD_RUN_CONTROLLER_HMAC_SECRET_VERSION",
      "--env",
      "production",
    ],
    { input: version, label: "production controller secret version registration" },
  );
  return version;
}

function applyFoundation() {
  ensureDeploymentRole();
  for (const identity of plan.identities) ensureServiceAccount(identity.account);
  ensureServiceAccount(plan.controller.account);
  ensureServiceAccount(plan.controller.runtimeAccount);
  for (const identity of plan.identities) {
    ensureProvider(identity);
    addServiceAccountBinding(
      identity.account.email,
      identity.principal,
      "roles/iam.workloadIdentityUser",
    );
    addProjectBinding(`serviceAccount:${identity.account.email}`, plan.deploymentRole.name);
  }
  addServiceAccountBinding(
    plan.controller.account.email,
    `serviceAccount:${plan.identities[1].account.email}`,
    "roles/iam.serviceAccountUser",
  );
  addServiceAccountBinding(
    "gpu-controller@scribe-drop.iam.gserviceaccount.com",
    `serviceAccount:${plan.identities[0].account.email}`,
    "roles/iam.serviceAccountUser",
  );
  ensureDatabase();
  addControllerBindings();
  addDeploymentArtifactBindings();
  const secretVersion = rotatePrimarySecret();
  run(process.execPath, ["scripts/verify-cloud-run-deployment-foundation.mjs", "staging"], {
    label: "staging foundation final read-back",
  });
  run(process.execPath, ["scripts/verify-cloud-run-deployment-foundation.mjs", "production"], {
    environment: {
      ...process.env,
      SCRIBE_DROP_PRODUCTION_CLOUD_RUN_CONTROLLER_HMAC_SECRET_VERSION: secretVersion,
    },
    label: "production foundation final read-back",
  });
  console.log(
    JSON.stringify({
      controllerService: "absent-until-promotion",
      productionSecretVersion: secretVersion,
      serviceAccountCount: 4,
      workloadIdentityProviderCount: 2,
    }),
  );
}

const [command, confirmation] = process.argv.slice(2);
if (
  command !== "apply" ||
  confirmation !== "--confirm-production-foundation" ||
  process.argv.length !== 4
) {
  throw new Error(
    "Usage: manage-cloud-run-deployment-foundation apply --confirm-production-foundation",
  );
}

try {
  applyFoundation();
} catch (error) {
  console.error(error instanceof Error ? error.message : "Cloud Run deployment foundation failed");
  process.exitCode = 1;
}
