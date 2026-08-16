import process from "node:process";
import { readFileSync } from "node:fs";
import path from "node:path";

import { parseCloudRunCandidateEvidence } from "./cloud-run-candidate-evidence.mjs";
import {
  controllerDeployment,
  createControllerAuthorization,
  createControllerDeploymentConfiguration,
  createControllerServicePatchUrl,
  createControllerServiceRequest,
  isAllowedControllerDisable,
  isAllowedControllerRecoveryDisable,
  isExactControllerAuthorizationRetry,
  preflightExistingControllerService,
  requireControllerServiceValidationOperation,
} from "./cloud-run-controller-deployment.mjs";

const PROJECT_ID = "scribe-drop";
const PROJECT_NUMBER = "601035271372";
const tokenPattern = /^[\x21-\x7e]{20,8192}$/u;
const hostnamePattern = /^[a-z0-9](?:[a-z0-9.-]{1,251}[a-z0-9])?$/u;
const secretVersionPattern = /^[1-9][0-9]*$/u;

function requireValue(value, pattern, name) {
  if (typeof value !== "string" || !pattern.test(value)) {
    throw new Error(`${name} is missing or invalid`);
  }
  return value;
}

function requireExactOrigin(value, name) {
  if (typeof value !== "string") throw new Error(`${name} is missing or invalid`);
  try {
    const url = new URL(value);
    if (
      url.protocol !== "https:" ||
      url.origin !== value ||
      url.username !== "" ||
      url.password !== "" ||
      url.port !== ""
    ) {
      throw new Error("invalid origin");
    }
  } catch {
    throw new Error(`${name} is missing or invalid`);
  }
  return value;
}

function authorization(mode) {
  const integer = (value) =>
    typeof value === "string" && /^(?:0|[1-9][0-9]*)$/u.test(value) ? Number(value) : undefined;
  return createControllerAuthorization({
    environment: selectedEnvironment,
    epoch: process.env.SCRIBE_DROP_CLOUD_RUN_AUTHORIZATION_EPOCH,
    maxExecutions: integer(process.env.SCRIBE_DROP_CLOUD_RUN_MAX_EXECUTIONS),
    maxWorstCaseJpy: integer(process.env.SCRIBE_DROP_CLOUD_RUN_MAX_WORST_CASE_JPY),
    mode,
    now: new Date(),
    validUntil: process.env.SCRIBE_DROP_CLOUD_RUN_AUTHORIZATION_VALID_UNTIL,
  });
}

async function googleRequest(url, init = {}) {
  const response = await fetch(url, {
    ...init,
    headers: {
      authorization: `Bearer ${accessToken}`,
      "content-type": "application/json",
      "x-goog-user-project": PROJECT_ID,
      ...init.headers,
    },
    redirect: "manual",
    signal: AbortSignal.timeout(15_000),
  });
  const text = await response.text();
  if (text.length > 512 * 1024) throw new Error("Google API response exceeded the safe limit");
  let body;
  try {
    body = text === "" ? {} : JSON.parse(text);
  } catch {
    throw new Error(`Google API returned non-JSON status ${response.status}`);
  }
  return { body, status: response.status };
}

function integerValue(value) {
  return { integerValue: String(value) };
}

function stringValue(value) {
  return { stringValue: value };
}

function authorizationDocumentBody(selected) {
  return {
    fields: {
      activeExecutionHandle: { nullValue: null },
      activeExecutions: integerValue(0),
      environment: stringValue(selected.environment),
      epoch: stringValue(selected.epoch),
      maxExecutions: integerValue(selected.maxExecutions),
      maxRequestsPerMinute: integerValue(selected.maxRequestsPerMinute),
      maxWorstCaseJpy: integerValue(selected.maxWorstCaseJpy),
      policyId: stringValue("cloud_run_jobs_l4_v1"),
      recentAcceptedAt: { arrayValue: { values: [] } },
      reservedExecutions: integerValue(0),
      reservedWorstCaseJpy: integerValue(0),
      schemaVersion: integerValue(1),
      updatedAt: stringValue(new Date().toISOString()),
      validUntil: stringValue(selected.validUntil),
      worstCaseJpyPerExecution: integerValue(selected.worstCaseJpyPerExecution),
    },
  };
}

function integerField(document, name) {
  const value = document?.fields?.[name]?.integerValue;
  if (typeof value !== "string" || !/^(?:0|[1-9][0-9]*)$/u.test(value)) {
    throw new Error("Controller authorization document is invalid");
  }
  return Number(value);
}

function stringField(document, name) {
  const value = document?.fields?.[name]?.stringValue;
  if (typeof value !== "string") throw new Error("Controller authorization document is invalid");
  return value;
}

function observedAuthorization(document) {
  return {
    activeExecutions: integerField(document, "activeExecutions"),
    environment: stringField(document, "environment"),
    epoch: stringField(document, "epoch"),
    maxExecutions: integerField(document, "maxExecutions"),
    maxRequestsPerMinute: integerField(document, "maxRequestsPerMinute"),
    maxWorstCaseJpy: integerField(document, "maxWorstCaseJpy"),
    reservedExecutions: integerField(document, "reservedExecutions"),
    reservedWorstCaseJpy: integerField(document, "reservedWorstCaseJpy"),
    validUntil: stringField(document, "validUntil"),
    worstCaseJpyPerExecution: integerField(document, "worstCaseJpyPerExecution"),
  };
}

async function readAuthorizationDocument() {
  const documentUrl =
    `https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/${deployment.databaseId}` +
    `/documents/scribe_drop_controller_environments/${selectedEnvironment}`;
  const current = await googleRequest(documentUrl, { method: "GET" });
  if (current.status !== 200 && current.status !== 404) {
    throw new Error(`Controller authorization read failed: ${current.status}`);
  }
  return { current, documentUrl };
}

async function requireRecoveryReady(expectedEpoch) {
  const { current } = await readAuthorizationDocument();
  if (current.status === 404) return;
  if (!isAllowedControllerRecoveryDisable(observedAuthorization(current.body), expectedEpoch)) {
    throw new Error("Controller recovery state does not match this staging workflow run");
  }
}

async function writeAuthorization(selected, expectedReservedExecutions, recoveryEpoch) {
  const { current, documentUrl } = await readAuthorizationDocument();
  if (current.status === 200 && integerField(current.body, "activeExecutions") !== 0) {
    throw new Error("Controller authorization cannot change while capacity is reserved");
  }
  if (
    selected.epoch === "disabled" &&
    ((current.status === 404 && expectedReservedExecutions !== 0) ||
      (current.status === 200 &&
        !(recoveryEpoch === undefined
          ? isAllowedControllerDisable(
              observedAuthorization(current.body),
              expectedReservedExecutions,
            )
          : isAllowedControllerRecoveryDisable(
              observedAuthorization(current.body),
              recoveryEpoch,
            ))))
  ) {
    throw new Error("Controller disable reservation expectation does not match");
  }
  if (current.status === 200 && selected.epoch !== "disabled") {
    const reservedExecutions = integerField(current.body, "reservedExecutions");
    const reservedWorstCaseJpy = integerField(current.body, "reservedWorstCaseJpy");
    const currentEpoch = stringField(current.body, "epoch");
    const exactRetry = isExactControllerAuthorizationRetry(selected, {
      activeExecutions: integerField(current.body, "activeExecutions"),
      environment: stringField(current.body, "environment"),
      epoch: currentEpoch,
      maxExecutions: integerField(current.body, "maxExecutions"),
      maxRequestsPerMinute: integerField(current.body, "maxRequestsPerMinute"),
      maxWorstCaseJpy: integerField(current.body, "maxWorstCaseJpy"),
      reservedExecutions,
      reservedWorstCaseJpy,
      validUntil: stringField(current.body, "validUntil"),
      worstCaseJpyPerExecution: integerField(current.body, "worstCaseJpyPerExecution"),
    });
    if (exactRetry) return;
    if (currentEpoch !== "disabled" || reservedExecutions !== 0 || reservedWorstCaseJpy !== 0) {
      throw new Error("A finite authorization must start from the disabled zero state");
    }
  }
  const condition = new URLSearchParams();
  if (current.status === 200) {
    const updateTime = requireValue(
      current.body.updateTime,
      /^20[0-9]{2}-[0-9]{2}-[0-9]{2}T[0-9:.]+Z$/u,
      "Controller authorization update time",
    );
    condition.set("currentDocument.updateTime", updateTime);
  } else {
    condition.set("currentDocument.exists", "false");
  }
  const written = await googleRequest(`${documentUrl}?${condition.toString()}`, {
    body: JSON.stringify(authorizationDocumentBody(selected)),
    method: "PATCH",
  });
  if (written.status !== 200) {
    throw new Error(`Controller authorization update failed: ${written.status}`);
  }
}

async function waitForOperation(operation) {
  let current = operation;
  if (typeof current !== "object" || current === null || Array.isArray(current)) {
    throw new Error("Cloud Run operation is invalid");
  }
  requireValue(current.name, /^projects\/.+\/operations\/.+$/u, "Cloud Run operation name");
  for (let attempt = 0; attempt < 90; attempt += 1) {
    if (current.done === true) {
      if (current.error !== undefined) throw new Error("Cloud Run Service operation failed");
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 2_000));
    const read = await googleRequest(`https://run.googleapis.com/v2/${current.name}`, {
      method: "GET",
    });
    if (read.status !== 200) throw new Error(`Cloud Run operation read failed: ${read.status}`);
    current = read.body;
  }
  throw new Error("Cloud Run Service operation did not converge");
}

async function deployService(plan) {
  const response = await googleRequest(createControllerServicePatchUrl(plan), {
    body: JSON.stringify(createControllerServiceRequest(plan)),
    method: "PATCH",
  });
  if (response.status !== 200) {
    throw new Error(`Cloud Run Service update failed: ${response.status}`);
  }
  await waitForOperation(response.body);
}

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

async function readServiceGuard(plan) {
  const response = await googleRequest(`https://run.googleapis.com/v2/${plan.name}`, {
    method: "GET",
  });
  if (response.status === 404) return { exists: false };
  if (response.status !== 200) {
    throw new Error(`Cloud Run Service preflight read failed: ${response.status}`);
  }
  return { exists: true, snapshot: canonical(response.body) };
}

async function preflightService(plan) {
  return preflightExistingControllerService({
    readSnapshot: () => readServiceGuard(plan),
    sameSnapshot: (before, after) => canonical(before) === canonical(after),
    validate: async () => {
      const response = await googleRequest(createControllerServicePatchUrl(plan, true), {
        body: JSON.stringify(createControllerServiceRequest(plan)),
        method: "PATCH",
      });
      if (response.status !== 200) {
        throw new Error(`Cloud Run Service validation failed: ${response.status}`);
      }
      requireControllerServiceValidationOperation(response.body);
    },
  });
}

async function readAndVerify(deploymentConfiguration) {
  const { GoogleControllerDeploymentReadbackClient } =
    await import("../apps/gpu-controller/dist/index.js");
  return new GoogleControllerDeploymentReadbackClient({
    getAccessToken: async () => accessToken,
  }).readAndVerify({
    binaryAuthorization: {
      attestors: [`projects/${PROJECT_ID}/attestors/scribe-drop-release-candidate`],
      projectId: PROJECT_ID,
    },
    deployment: deploymentConfiguration,
    projectNumber: PROJECT_NUMBER,
  });
}

const [command, selectedEnvironment, authorizationMode, candidatePath] = process.argv.slice(2);
if (
  !new Set(["apply", "preflight", "read", "recover"]).has(command) ||
  !new Set(["staging", "production"]).has(selectedEnvironment) ||
  !new Set(["disabled", "operational", "smoke"]).has(authorizationMode) ||
  candidatePath === undefined ||
  process.argv.length !== 6
) {
  throw new Error(
    "Usage: manage-cloud-run-controller-deployment <apply|preflight|read|recover> <staging|production> <disabled|operational|smoke> <candidate-evidence>",
  );
}
if (
  command === "recover" &&
  (selectedEnvironment !== "staging" || authorizationMode !== "disabled")
) {
  throw new Error("Controller recovery is restricted to disabled staging authorization");
}
const deployment = controllerDeployment(selectedEnvironment);
const environmentPrefix = `SCRIBE_DROP_${selectedEnvironment.toUpperCase()}`;
const accessToken = requireValue(
  process.env.GOOGLE_OAUTH_ACCESS_TOKEN,
  tokenPattern,
  "Google OAuth access token",
);
const orchestratorOrigin = requireExactOrigin(
  process.env[`${environmentPrefix}_ORCHESTRATOR_ORIGIN`],
  `${selectedEnvironment} Orchestrator origin`,
);
const r2Host = requireValue(
  process.env[`${environmentPrefix}_R2_HOST`],
  hostnamePattern,
  `${selectedEnvironment} R2 host`,
);
const primarySecretVersion = requireValue(
  process.env[`${environmentPrefix}_CLOUD_RUN_CONTROLLER_HMAC_SECRET_VERSION`],
  secretVersionPattern,
  `${selectedEnvironment} controller HMAC secret version`,
);
const candidate = parseCloudRunCandidateEvidence(
  JSON.parse(readFileSync(path.resolve(candidatePath), "utf8")),
);
if (candidate.commit !== process.env.EXPECTED_COMMIT_SHA) {
  throw new Error("Cloud Run candidate commit does not match");
}
const selectedAuthorization = authorization(authorizationMode);
const expectedDisabledReservations = (() => {
  const value = process.env.SCRIBE_DROP_CLOUD_RUN_EXPECTED_RESERVED_EXECUTIONS ?? "0";
  if (!/^[01]$/u.test(value) || (authorizationMode !== "disabled" && value !== "0")) {
    throw new Error("Controller disable reservation expectation is invalid");
  }
  return Number(value);
})();
const recoveryEpoch =
  command === "recover"
    ? requireValue(
        process.env.SCRIBE_DROP_CLOUD_RUN_RECOVERY_EPOCH,
        /^phase16-smoke-[a-f0-9]{7,40}-[1-9][0-9]*$/u,
        "Controller recovery epoch",
      )
    : undefined;
const deploymentConfiguration = createControllerDeploymentConfiguration({
  authorization: selectedAuthorization,
  candidate,
  environment: selectedEnvironment,
  orchestratorOrigin,
  primarySecretVersion,
  r2Host,
});

try {
  const { createControllerServiceDeploymentPlan } =
    await import("../apps/gpu-controller/dist/index.js");
  const plan = createControllerServiceDeploymentPlan(deploymentConfiguration);
  if (command === "preflight") {
    const serviceExists = await preflightService(plan);
    const { GoogleControllerDeploymentReadbackClient } =
      await import("../apps/gpu-controller/dist/index.js");
    const preflight = await new GoogleControllerDeploymentReadbackClient({
      getAccessToken: async () => accessToken,
    }).preflight(
      {
        binaryAuthorization: {
          attestors: [`projects/${PROJECT_ID}/attestors/scribe-drop-release-candidate`],
          projectId: PROJECT_ID,
        },
        deployment: deploymentConfiguration,
        projectNumber: PROJECT_NUMBER,
      },
      { allowMissingService: !serviceExists },
    );
    console.log(
      JSON.stringify({
        environment: selectedEnvironment,
        readbackRequestCount: preflight.requestCount,
        serviceMutationObserved: false,
        serviceValidateOnly: true,
      }),
    );
  } else {
    if (command === "apply" || command === "recover") {
      if (command === "recover") await requireRecoveryReady(recoveryEpoch);
      await deployService(plan);
      await writeAuthorization(selectedAuthorization, expectedDisabledReservations, recoveryEpoch);
    }
    const evidence = await readAndVerify(deploymentConfiguration);
    console.log(
      JSON.stringify({
        authorization: authorizationMode,
        environment: selectedEnvironment,
        firestoreTtlFieldCount: evidence.firestore.ttlStates.length,
        serviceReady: true,
      }),
    );
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : "Cloud Run controller deployment failed");
  process.exitCode = 1;
}
