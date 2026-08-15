const PROJECT_ID = "scribe-drop";
const PROJECT_NUMBER = "601035271372";
const REGION = "asia-southeast1";
const SERVICE_NAME = "scribe-drop-staging-gpu-controller";
const SECRET_NAME = "scribe-drop-staging-controller-primary";
const RUNTIME_SERVICE_ACCOUNT = "gpu-runtime@scribe-drop.iam.gserviceaccount.com";
const CONTROLLER_ORIGIN =
  "https://scribe-drop-staging-gpu-controller-601035271372.asia-southeast1.run.app";

function requireRecord(value, label) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} is invalid`);
  }
  return value;
}

function requireString(value, pattern, label) {
  if (typeof value !== "string" || !pattern.test(value)) {
    throw new Error(`${label} is missing or invalid`);
  }
  return value;
}

export function parseStagingReleaseInputs(environment) {
  const accountId = requireString(
    environment.CLOUDFLARE_ACCOUNT_ID,
    /^[a-f0-9]{32}$/u,
    "Staging Cloudflare account ID",
  );
  const controllerOrigin = requireString(
    environment.SCRIBE_DROP_STAGING_CLOUD_RUN_CONTROLLER_ORIGIN,
    /^https:\/\/[a-z0-9.-]+$/u,
    "Staging controller origin",
  );
  const runtimeServiceAccount = requireString(
    environment.SCRIBE_DROP_STAGING_CLOUD_RUN_RUNTIME_SERVICE_ACCOUNT,
    /^[a-z0-9-]+@[a-z0-9.-]+\.iam\.gserviceaccount\.com$/u,
    "Staging runtime service account",
  );
  const r2Host = requireString(
    environment.SCRIBE_DROP_STAGING_R2_HOST,
    /^[a-f0-9]{32}\.r2\.cloudflarestorage\.com$/u,
    "Staging R2 host",
  );
  const primarySecretVersion = requireString(
    environment.SCRIBE_DROP_STAGING_CLOUD_RUN_CONTROLLER_HMAC_SECRET_VERSION,
    /^[1-9][0-9]*$/u,
    "Staging controller HMAC secret version",
  );
  if (controllerOrigin !== CONTROLLER_ORIGIN) {
    throw new Error("Staging controller origin does not match the numeric Cloud Run origin");
  }
  if (runtimeServiceAccount !== RUNTIME_SERVICE_ACCOUNT) {
    throw new Error("Staging runtime service account does not match the reviewed identity");
  }
  if (r2Host !== `${accountId}.r2.cloudflarestorage.com`) {
    throw new Error("Staging R2 host does not match the isolated Cloudflare account");
  }
  return { accountId, controllerOrigin, primarySecretVersion, r2Host, runtimeServiceAccount };
}

export function verifyStagingReleaseInputs(environment, untrustedObserved) {
  const selected = parseStagingReleaseInputs(environment);
  const observed = requireRecord(untrustedObserved, "Staging release input read-back");
  const service = requireRecord(observed.service, "Staging controller Service");
  const runtimeAccount = requireRecord(
    observed.runtimeServiceAccount,
    "Staging runtime service account",
  );
  const secretVersion = requireRecord(
    observed.primarySecretVersion,
    "Staging controller HMAC secret version",
  );
  const serviceOrigins = new Set([
    ...(typeof service.uri === "string" ? [service.uri] : []),
    ...(Array.isArray(service.urls)
      ? service.urls.filter((value) => typeof value === "string")
      : []),
  ]);
  if (
    service.name !== `projects/${PROJECT_ID}/locations/${REGION}/services/${SERVICE_NAME}` ||
    !serviceOrigins.has(selected.controllerOrigin)
  ) {
    throw new Error("Staging controller origin is not attached to the reviewed Cloud Run Service");
  }
  if (
    runtimeAccount.name !== `projects/${PROJECT_ID}/serviceAccounts/${RUNTIME_SERVICE_ACCOUNT}` ||
    runtimeAccount.email !== RUNTIME_SERVICE_ACCOUNT ||
    runtimeAccount.disabled === true
  ) {
    throw new Error("Staging runtime service account read-back does not match");
  }
  if (
    secretVersion.name !==
      `projects/${PROJECT_NUMBER}/secrets/${SECRET_NAME}/versions/${selected.primarySecretVersion}` ||
    secretVersion.state !== "ENABLED"
  ) {
    throw new Error("Staging controller HMAC secret version read-back does not match");
  }
  return {
    controllerOrigin: "verified",
    primarySecretVersion: "enabled",
    r2Host: "verified",
    runtimeServiceAccount: "verified",
  };
}

export const stagingReleaseResources = Object.freeze({
  projectId: PROJECT_ID,
  region: REGION,
  runtimeServiceAccount: RUNTIME_SERVICE_ACCOUNT,
  secretName: SECRET_NAME,
  serviceName: SERVICE_NAME,
});
