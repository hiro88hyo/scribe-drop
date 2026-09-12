const SERVICE_NAME = "scribe-drop-production-gpu-controller";
const PROJECT_ID = "scribe-drop";
const REGION = "asia-southeast1";
const POLICY_ID = "cloud_run_jobs_l4_v1";
const CONTROLLER_ACCOUNT = "gpu-controller-production@scribe-drop.iam.gserviceaccount.com";
const COST_PER_EXECUTION = 250;
const MAX_LIFETIME_MS = 24 * 60 * 60 * 1_000;
const MIN_LIFETIME_MS = 30 * 60 * 1_000;
const epochPattern = /^phase16-operational-([a-f0-9]{7,40})-([1-9][0-9]*)$/u;

export const productionAuthorizationRenewalTarget = Object.freeze({
  controllerAccount: CONTROLLER_ACCOUNT,
  policyId: POLICY_ID,
  projectId: PROJECT_ID,
  region: REGION,
  serviceName: SERVICE_NAME,
});

function record(value, label) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} is invalid`);
  }
  return value;
}

function canonicalInteger(value, label, minimum, maximum) {
  const text = typeof value === "number" ? String(value) : value;
  if (typeof text !== "string" || !/^(?:0|[1-9][0-9]*)$/u.test(text)) {
    throw new Error(`${label} is invalid`);
  }
  const parsed = Number(text);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${label} is outside the reviewed range`);
  }
  return parsed;
}

function canonicalTimestamp(value, label) {
  if (typeof value !== "string") throw new Error(`${label} is invalid`);
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds) || new Date(milliseconds).toISOString() !== value) {
    throw new Error(`${label} is invalid`);
  }
  return value;
}

export function createProductionAuthorizationRenewal(input) {
  const now = input?.now;
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) {
    throw new Error("Production authorization renewal clock is invalid");
  }
  const previousEpoch = input?.previousEpoch;
  const match = typeof previousEpoch === "string" ? epochPattern.exec(previousEpoch) : null;
  if (match === null) throw new Error("Previous production authorization epoch is invalid");
  const candidateCommit = match[1];
  if (candidateCommit === undefined) {
    throw new Error("Previous production authorization candidate is invalid");
  }
  const runId = canonicalInteger(
    input?.runId,
    "Production authorization renewal run ID",
    1,
    10 ** 15,
  );
  const maxExecutions = canonicalInteger(
    input?.maxExecutions,
    "Production authorization execution cap",
    1,
    20,
  );
  const maxWorstCaseJpy = canonicalInteger(
    input?.maxWorstCaseJpy,
    "Production authorization maximum worst-case cost",
    COST_PER_EXECUTION,
    20 * COST_PER_EXECUTION,
  );
  if (maxWorstCaseJpy !== maxExecutions * COST_PER_EXECUTION) {
    throw new Error("Production authorization cost does not match the execution cap");
  }
  const validUntil = canonicalTimestamp(
    input?.validUntil,
    "Production authorization renewal expiry",
  );
  const expiry = Date.parse(validUntil);
  if (expiry <= now.getTime() + MIN_LIFETIME_MS || expiry > now.getTime() + MAX_LIFETIME_MS) {
    throw new Error("Production authorization renewal expiry is outside the reviewed window");
  }
  const epoch = `phase16-operational-${candidateCommit}-${runId}`;
  if (epoch === previousEpoch) {
    throw new Error("Production authorization renewal epoch must be new");
  }
  return Object.freeze({
    environment: "production",
    epoch,
    maxExecutions,
    maxRequestsPerMinute: 60,
    maxWorstCaseJpy,
    validUntil,
    worstCaseJpyPerExecution: COST_PER_EXECUTION,
  });
}

export function createPreviousProductionAuthorization(input) {
  const now = input?.now;
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) {
    throw new Error("Production authorization renewal clock is invalid");
  }
  const epoch = input?.epoch;
  if (typeof epoch !== "string" || !epochPattern.test(epoch)) {
    throw new Error("Previous production authorization epoch is invalid");
  }
  const maxExecutions = canonicalInteger(
    input?.maxExecutions,
    "Previous production authorization execution cap",
    1,
    20,
  );
  const validUntil = canonicalTimestamp(
    input?.validUntil,
    "Previous production authorization expiry",
  );
  if (Date.parse(validUntil) >= now.getTime()) {
    throw new Error("Previous production authorization has not expired");
  }
  return Object.freeze({
    environment: "production",
    epoch,
    maxExecutions,
    maxRequestsPerMinute: 60,
    maxWorstCaseJpy: maxExecutions * COST_PER_EXECUTION,
    validUntil,
    worstCaseJpyPerExecution: COST_PER_EXECUTION,
  });
}

function authorizationFromPairs(pairs, label) {
  const values = new Map();
  for (const pair of pairs) {
    const item = record(pair, `${label} item`);
    if (typeof item.name !== "string" || values.has(item.name)) {
      throw new Error(`${label} contains an invalid or duplicate name`);
    }
    values.set(item.name, item.value);
  }
  const text = (name) => {
    const value = values.get(name);
    if (typeof value !== "string") throw new Error(`${label} is missing ${name}`);
    return value;
  };
  return {
    environment: text("APP_ENV"),
    epoch: text("SCRIBE_DROP_AUTHORIZATION_EPOCH"),
    maxExecutions: canonicalInteger(
      text("SCRIBE_DROP_AUTHORIZATION_MAX_EXECUTIONS"),
      `${label} maximum executions`,
      0,
      100,
    ),
    maxRequestsPerMinute: canonicalInteger(
      text("SCRIBE_DROP_AUTHORIZATION_MAX_REQUESTS_PER_MINUTE"),
      `${label} request rate`,
      0,
      120,
    ),
    maxWorstCaseJpy: canonicalInteger(
      text("SCRIBE_DROP_AUTHORIZATION_MAX_WORST_CASE_JPY"),
      `${label} maximum cost`,
      0,
      10_000_000,
    ),
    validUntil: canonicalTimestamp(
      text("SCRIBE_DROP_AUTHORIZATION_VALID_UNTIL"),
      `${label} expiry`,
    ),
    worstCaseJpyPerExecution: canonicalInteger(
      text("SCRIBE_DROP_AUTHORIZATION_WORST_CASE_JPY_PER_EXECUTION"),
      `${label} per-execution cost`,
      0,
      10_000_000,
    ),
  };
}

export function parseProductionControllerService(value) {
  const service = record(value, "Production controller Service");
  const metadata = record(service.metadata, "Production controller Service metadata");
  const labels = record(metadata.labels, "Production controller Service labels");
  const spec = record(service.spec, "Production controller Service spec");
  const template = record(spec.template, "Production controller Service template");
  const templateSpec = record(template.spec, "Production controller Service template spec");
  if (
    metadata.name !== SERVICE_NAME ||
    labels["cloud.googleapis.com/location"] !== REGION ||
    labels["scribe-drop-component"] !== "gpu-controller" ||
    labels["scribe-drop-environment"] !== "production" ||
    labels["scribe-drop-policy"] !== "cloud-run-jobs-l4-v1" ||
    templateSpec.serviceAccountName !== CONTROLLER_ACCOUNT
  ) {
    throw new Error("Production controller Service identity does not match");
  }
  if (!Array.isArray(templateSpec.containers) || templateSpec.containers.length !== 1) {
    throw new Error("Production controller Service container set is invalid");
  }
  const container = record(templateSpec.containers[0], "Production controller Service container");
  if (
    typeof container.image !== "string" ||
    !new RegExp(
      `^${REGION}-docker\\.pkg\\.dev/${PROJECT_ID}/controller/runtime@sha256:[0-9a-f]{64}$`,
      "u",
    ).test(container.image) ||
    !Array.isArray(container.env)
  ) {
    throw new Error("Production controller Service image or environment is invalid");
  }
  const status = record(service.status, "Production controller Service status");
  if (
    !Array.isArray(status.conditions) ||
    !status.conditions.some((condition) => {
      const item = record(condition, "Production controller Service condition");
      return item.type === "Ready" && item.status === "True";
    })
  ) {
    throw new Error("Production controller Service is not ready");
  }
  return {
    authorization: authorizationFromPairs(container.env, "Production controller Service"),
    imageDigest: container.image,
  };
}

function firestoreString(fields, name) {
  const field = record(fields[name], `Production authorization ${name}`);
  if (typeof field.stringValue !== "string") {
    throw new Error(`Production authorization ${name} is invalid`);
  }
  return field.stringValue;
}

function firestoreInteger(fields, name, maximum = 10_000_000) {
  const field = record(fields[name], `Production authorization ${name}`);
  return canonicalInteger(field.integerValue, `Production authorization ${name}`, 0, maximum);
}

export function parseProductionAuthorizationDocument(value) {
  const document = record(value, "Production authorization document");
  const fields = record(document.fields, "Production authorization fields");
  const activeHandle = record(
    fields.activeExecutionHandle,
    "Production authorization active execution handle",
  );
  const recent = record(fields.recentAcceptedAt, "Production authorization recent requests");
  const recentValues = record(
    recent.arrayValue,
    "Production authorization recent request array",
  ).values;
  if (recentValues !== undefined && !Array.isArray(recentValues)) {
    throw new Error("Production authorization recent requests are invalid");
  }
  const authorization = {
    environment: firestoreString(fields, "environment"),
    epoch: firestoreString(fields, "epoch"),
    maxExecutions: firestoreInteger(fields, "maxExecutions", 100),
    maxRequestsPerMinute: firestoreInteger(fields, "maxRequestsPerMinute", 120),
    maxWorstCaseJpy: firestoreInteger(fields, "maxWorstCaseJpy"),
    validUntil: canonicalTimestamp(
      firestoreString(fields, "validUntil"),
      "Production authorization expiry",
    ),
    worstCaseJpyPerExecution: firestoreInteger(fields, "worstCaseJpyPerExecution"),
  };
  const activeExecutions = firestoreInteger(fields, "activeExecutions", 1);
  const reservedExecutions = firestoreInteger(fields, "reservedExecutions", 100);
  const reservedWorstCaseJpy = firestoreInteger(fields, "reservedWorstCaseJpy");
  if (
    firestoreString(fields, "policyId") !== POLICY_ID ||
    firestoreInteger(fields, "schemaVersion", 1) !== 1 ||
    authorization.environment !== "production" ||
    reservedExecutions < activeExecutions ||
    reservedExecutions > authorization.maxExecutions ||
    reservedWorstCaseJpy !== reservedExecutions * authorization.worstCaseJpyPerExecution ||
    reservedWorstCaseJpy > authorization.maxWorstCaseJpy ||
    (activeExecutions === 0) !== (activeHandle.nullValue === null)
  ) {
    throw new Error("Production authorization document invariants do not match");
  }
  if (typeof document.updateTime !== "string") {
    throw new Error("Production authorization document update time is missing");
  }
  return {
    activeExecutions,
    authorization,
    recentAcceptedCount: recentValues?.length ?? 0,
    reservedExecutions,
    reservedWorstCaseJpy,
    updateTime: canonicalTimestamp(document.updateTime, "Production authorization update time"),
  };
}

function sameAuthorization(left, right) {
  return (
    left.environment === right.environment &&
    left.epoch === right.epoch &&
    left.maxExecutions === right.maxExecutions &&
    left.maxRequestsPerMinute === right.maxRequestsPerMinute &&
    left.maxWorstCaseJpy === right.maxWorstCaseJpy &&
    left.validUntil === right.validUntil &&
    left.worstCaseJpyPerExecution === right.worstCaseJpyPerExecution
  );
}

export function classifyProductionAuthorizationRenewal(input) {
  const previous = input?.previous;
  const desired = input?.desired;
  const service = input?.service;
  const document = input?.document;
  const now = input?.now;
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) {
    throw new Error("Production authorization renewal clock is invalid");
  }
  if (
    !sameAuthorization(service.authorization, previous) &&
    !sameAuthorization(service.authorization, desired)
  ) {
    throw new Error("Production controller Service authorization is outside the renewal prefixes");
  }
  if (
    !sameAuthorization(document.authorization, previous) &&
    !sameAuthorization(document.authorization, desired)
  ) {
    throw new Error("Production Firestore authorization is outside the renewal prefixes");
  }
  const serviceDesired = sameAuthorization(service.authorization, desired);
  const documentDesired = sameAuthorization(document.authorization, desired);
  if (!documentDesired && Date.parse(previous.validUntil) >= now.getTime()) {
    throw new Error("Previous production authorization has not expired");
  }
  if (!documentDesired && document.activeExecutions !== 0) {
    throw new Error("Expired production authorization still has an active execution");
  }
  if (documentDesired) {
    if (
      document.reservedExecutions > desired.maxExecutions ||
      document.reservedWorstCaseJpy !==
        document.reservedExecutions * desired.worstCaseJpyPerExecution
    ) {
      throw new Error("Renewed production authorization consumption is invalid");
    }
  }
  return serviceDesired
    ? documentDesired
      ? "active"
      : "service-updated"
    : documentDesired
      ? "firestore-updated"
      : "expired";
}

export function serviceAuthorizationEnvironment(authorization) {
  return Object.freeze({
    SCRIBE_DROP_AUTHORIZATION_EPOCH: authorization.epoch,
    SCRIBE_DROP_AUTHORIZATION_MAX_EXECUTIONS: String(authorization.maxExecutions),
    SCRIBE_DROP_AUTHORIZATION_MAX_REQUESTS_PER_MINUTE: String(authorization.maxRequestsPerMinute),
    SCRIBE_DROP_AUTHORIZATION_MAX_WORST_CASE_JPY: String(authorization.maxWorstCaseJpy),
    SCRIBE_DROP_AUTHORIZATION_VALID_UNTIL: authorization.validUntil,
    SCRIBE_DROP_AUTHORIZATION_WORST_CASE_JPY_PER_EXECUTION: String(
      authorization.worstCaseJpyPerExecution,
    ),
  });
}

export function firestoreAuthorizationPatch(authorization, updateTime, updatedAt) {
  canonicalTimestamp(updateTime, "Production authorization update precondition");
  canonicalTimestamp(updatedAt, "Production authorization update timestamp");
  const integerValue = (value) => ({ integerValue: String(value) });
  const stringValue = (value) => ({ stringValue: value });
  return {
    body: {
      fields: {
        epoch: stringValue(authorization.epoch),
        maxExecutions: integerValue(authorization.maxExecutions),
        maxRequestsPerMinute: integerValue(authorization.maxRequestsPerMinute),
        maxWorstCaseJpy: integerValue(authorization.maxWorstCaseJpy),
        recentAcceptedAt: { arrayValue: { values: [] } },
        reservedExecutions: integerValue(0),
        reservedWorstCaseJpy: integerValue(0),
        updatedAt: stringValue(updatedAt),
        validUntil: stringValue(authorization.validUntil),
        worstCaseJpyPerExecution: integerValue(authorization.worstCaseJpyPerExecution),
      },
    },
    updateTime,
  };
}
