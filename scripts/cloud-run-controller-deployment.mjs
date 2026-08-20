const PROJECT_ID = "scribe-drop";
const AUTHORIZATION_EPOCH_PATTERN = /^phase16-(?:operational|smoke)-[a-f0-9]{7,40}-[1-9][0-9]*$/u;
const AUTHORIZATION_TIMESTAMP_PATTERN = /^20[0-9]{2}-[0-9]{2}-[0-9]{2}T[0-9:.]+Z$/u;
const WORST_CASE_JPY_PER_EXECUTION = 250;

const deployments = Object.freeze({
  staging: {
    controllerServiceAccount: "gpu-controller@scribe-drop.iam.gserviceaccount.com",
    databaseId: "scribe-staging-controller",
    primarySecretName: "scribe-drop-staging-controller-primary",
    runtimeServiceAccount: "gpu-runtime@scribe-drop.iam.gserviceaccount.com",
    serviceName: "scribe-drop-staging-gpu-controller",
  },
  production: {
    controllerServiceAccount: "gpu-controller-production@scribe-drop.iam.gserviceaccount.com",
    databaseId: "scribe-production-controller",
    primarySecretName: "scribe-drop-production-controller-primary",
    runtimeServiceAccount: "gpu-runtime-production@scribe-drop.iam.gserviceaccount.com",
    serviceName: "scribe-drop-production-gpu-controller",
  },
});

export function controllerDeployment(environment) {
  const selected = deployments[environment];
  if (selected === undefined) throw new Error("Controller deployment environment is invalid");
  return selected;
}

function canonicalExpiry(value, now, maximumLifetimeMs) {
  if (typeof value !== "string" || !AUTHORIZATION_TIMESTAMP_PATTERN.test(value)) {
    throw new Error("Controller authorization expiry is missing or invalid");
  }
  const expiry = Date.parse(value);
  if (
    !Number.isFinite(expiry) ||
    new Date(expiry).toISOString() !== value ||
    expiry <= now.getTime() + 30 * 60 * 1_000 ||
    expiry > now.getTime() + maximumLifetimeMs
  ) {
    throw new Error("Controller authorization expiry is outside the reviewed window");
  }
  return value;
}

export function createControllerAuthorization({
  environment,
  epoch,
  maxExecutions,
  maxWorstCaseJpy,
  mode,
  now,
  validUntil,
}) {
  controllerDeployment(environment);
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) {
    throw new Error("Controller authorization clock is invalid");
  }
  if (mode === "disabled") {
    return {
      environment,
      epoch: "disabled",
      maxExecutions: 0,
      maxRequestsPerMinute: 0,
      maxWorstCaseJpy: 0,
      validUntil: "1970-01-01T00:00:00.000Z",
      worstCaseJpyPerExecution: 0,
    };
  }
  if (typeof epoch !== "string" || !AUTHORIZATION_EPOCH_PATTERN.test(epoch)) {
    throw new Error("Controller authorization epoch is missing or invalid");
  }
  if (mode === "smoke") {
    return {
      environment,
      epoch,
      maxExecutions: 1,
      maxRequestsPerMinute: 60,
      maxWorstCaseJpy: WORST_CASE_JPY_PER_EXECUTION,
      validUntil: canonicalExpiry(validUntil, now, 3 * 60 * 60 * 1_000),
      worstCaseJpyPerExecution: WORST_CASE_JPY_PER_EXECUTION,
    };
  }
  if (
    mode !== "operational" ||
    !Number.isSafeInteger(maxExecutions) ||
    maxExecutions < 1 ||
    maxExecutions > 20 ||
    maxWorstCaseJpy !== maxExecutions * WORST_CASE_JPY_PER_EXECUTION
  ) {
    throw new Error("Operational controller authorization budget is invalid");
  }
  return {
    environment,
    epoch,
    maxExecutions,
    maxRequestsPerMinute: 60,
    maxWorstCaseJpy,
    validUntil: canonicalExpiry(validUntil, now, 24 * 60 * 60 * 1_000),
    worstCaseJpyPerExecution: WORST_CASE_JPY_PER_EXECUTION,
  };
}

export function isExactControllerAuthorizationRetry(selected, observed) {
  return (
    observed.activeExecutions === 0 &&
    observed.environment === selected.environment &&
    observed.epoch === selected.epoch &&
    observed.maxExecutions === selected.maxExecutions &&
    observed.maxRequestsPerMinute === selected.maxRequestsPerMinute &&
    observed.maxWorstCaseJpy === selected.maxWorstCaseJpy &&
    observed.reservedExecutions === 0 &&
    observed.reservedWorstCaseJpy === 0 &&
    observed.validUntil === selected.validUntil &&
    observed.worstCaseJpyPerExecution === selected.worstCaseJpyPerExecution
  );
}

export function isAllowedControllerDisable(observed, expectedReservedExecutions) {
  if (
    observed.activeExecutions !== 0 ||
    !new Set([0, 1]).has(expectedReservedExecutions) ||
    observed.reservedExecutions !== expectedReservedExecutions ||
    observed.reservedWorstCaseJpy !== expectedReservedExecutions * WORST_CASE_JPY_PER_EXECUTION
  ) {
    return false;
  }
  return (
    (expectedReservedExecutions === 0 &&
      observed.epoch === "disabled" &&
      observed.maxExecutions === 0 &&
      observed.maxWorstCaseJpy === 0 &&
      observed.worstCaseJpyPerExecution === 0) ||
    (expectedReservedExecutions === 1 &&
      observed.maxExecutions === 1 &&
      observed.maxWorstCaseJpy === WORST_CASE_JPY_PER_EXECUTION &&
      observed.worstCaseJpyPerExecution === WORST_CASE_JPY_PER_EXECUTION &&
      typeof observed.epoch === "string" &&
      observed.epoch.startsWith("phase16-smoke-") &&
      AUTHORIZATION_EPOCH_PATTERN.test(observed.epoch))
  );
}

export function isAllowedControllerRecoveryDisable(
  observed,
  expectedEpoch,
  expectedEnvironment = "staging",
) {
  if (
    typeof expectedEpoch !== "string" ||
    !expectedEpoch.startsWith("phase16-smoke-") ||
    !AUTHORIZATION_EPOCH_PATTERN.test(expectedEpoch) ||
    !new Set(["production", "staging"]).has(expectedEnvironment) ||
    observed.activeExecutions !== 0 ||
    observed.environment !== expectedEnvironment ||
    !new Set([0, 1]).has(observed.reservedExecutions) ||
    (expectedEnvironment === "production" && observed.reservedExecutions !== 0) ||
    observed.reservedWorstCaseJpy !== observed.reservedExecutions * WORST_CASE_JPY_PER_EXECUTION
  ) {
    return false;
  }
  if (observed.epoch === "disabled") {
    return (
      observed.maxExecutions === 0 &&
      observed.maxWorstCaseJpy === 0 &&
      observed.reservedExecutions === 0 &&
      observed.worstCaseJpyPerExecution === 0
    );
  }
  return (
    observed.epoch === expectedEpoch &&
    observed.maxExecutions === 1 &&
    observed.maxWorstCaseJpy === WORST_CASE_JPY_PER_EXECUTION &&
    observed.worstCaseJpyPerExecution === WORST_CASE_JPY_PER_EXECUTION
  );
}

export function createControllerDeploymentConfiguration({
  authorization,
  candidate,
  environment,
  orchestratorOrigin,
  primarySecretVersion,
  r2Host,
}) {
  const deployment = controllerDeployment(environment);
  if (candidate.commit.length !== 40) throw new Error("Cloud Run candidate commit is invalid");
  return {
    authorization,
    controllerImageDigest: candidate.controllerImage,
    controllerServiceAccount: deployment.controllerServiceAccount,
    firestore: { databaseId: deployment.databaseId, projectId: PROJECT_ID },
    manifest: {
      environment,
      imageDigest: candidate.workerImage,
      orchestratorOrigin: `${orchestratorOrigin}/`,
      projectId: PROJECT_ID,
      resultHost: r2Host,
      runtimeServiceAccount: deployment.runtimeServiceAccount,
      sourceHost: r2Host,
    },
    primaryHmacSecret: {
      name: deployment.primarySecretName,
      version: primarySecretVersion,
    },
    serviceName: deployment.serviceName,
  };
}

function controllerServiceMutableFields(plan) {
  const container = plan.template.containers[0];
  return {
    binaryAuthorization: plan.binaryAuthorization,
    ingress: plan.ingress,
    invokerIamDisabled: plan.invokerIamDisabled,
    labels: plan.labels,
    scaling: plan.scaling,
    template: {
      containers: [container],
      executionEnvironment: plan.template.executionEnvironment,
      labels: plan.template.labels,
      maxInstanceRequestConcurrency: plan.template.maxInstanceRequestConcurrency,
      scaling: plan.template.scaling,
      serviceAccount: plan.template.serviceAccount,
      sessionAffinity: plan.template.sessionAffinity,
      timeout: plan.template.timeout,
    },
    traffic: plan.traffic,
  };
}

export function createControllerServiceRequest(plan) {
  return { name: plan.name, ...controllerServiceMutableFields(plan) };
}

export function createControllerServiceCreateRequest(plan) {
  return controllerServiceMutableFields(plan);
}

export function createControllerServicePatchUrl(plan, validateOnly = false) {
  if (
    typeof plan?.name !== "string" ||
    !/^projects\/scribe-drop\/locations\/asia-southeast1\/services\/[a-z0-9-]+$/u.test(plan.name)
  ) {
    throw new Error("Controller Service deployment plan name is invalid");
  }
  const updateMask = [
    "binaryAuthorization",
    "ingress",
    "invokerIamDisabled",
    "labels",
    "scaling",
    "template",
    "traffic",
  ].join(",");
  const query = new URLSearchParams({
    allowMissing: "true",
    forceNewRevision: "true",
    updateMask,
  });
  if (validateOnly) query.set("validateOnly", "true");
  return `https://run.googleapis.com/v2/${plan.name}?${query.toString()}`;
}

export function createControllerServiceCreateUrl(plan, validateOnly = false) {
  const match =
    typeof plan?.name === "string"
      ? /^projects\/(?<project>scribe-drop)\/locations\/(?<location>asia-southeast1)\/services\/(?<service>[a-z0-9-]+)$/u.exec(
          plan.name,
        )
      : null;
  if (match?.groups === undefined) {
    throw new Error("Controller Service deployment plan name is invalid");
  }
  const query = new URLSearchParams({ serviceId: match.groups.service });
  if (validateOnly) query.set("validateOnly", "true");
  return (
    `https://run.googleapis.com/v2/projects/${match.groups.project}/locations/${match.groups.location}/services?` +
    query.toString()
  );
}

export function requireControllerServiceValidationOperation(value) {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    value.error !== undefined ||
    typeof value.name !== "string" ||
    !/^projects\/scribe-drop\/locations\/asia-southeast1\/operations\/[a-z0-9-]+$/u.test(value.name)
  ) {
    throw new Error("Cloud Run Service validation operation is invalid");
  }
  return { name: value.name };
}

export async function preflightExistingControllerService({
  readSnapshot,
  sameSnapshot,
  validate,
  validateMissing,
}) {
  const before = await readSnapshot();
  if (before.exists !== true) {
    await validateMissing();
    const after = await readSnapshot();
    if (after.exists !== false) {
      throw new Error("Cloud Run Service was created during validate-only preflight");
    }
    return false;
  }
  await validate();
  const after = await readSnapshot();
  if (!sameSnapshot(before, after)) {
    throw new Error("Cloud Run Service changed during validate-only preflight");
  }
  return true;
}
