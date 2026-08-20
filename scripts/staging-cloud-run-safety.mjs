function requireIntegerField(document, name) {
  const value = document?.fields?.[name]?.integerValue;
  if (typeof value !== "string" || !/^(?:0|[1-9][0-9]*)$/u.test(value)) {
    throw new Error("Staging controller authorization document is invalid");
  }
  return Number(value);
}

function requireStringField(document, name) {
  const value = document?.fields?.[name]?.stringValue;
  if (typeof value !== "string") {
    throw new Error("Staging controller authorization document is invalid");
  }
  return value;
}

export function parseStagingAuthorizationDocument(document) {
  if (document === undefined) return undefined;
  return {
    activeExecutions: requireIntegerField(document, "activeExecutions"),
    environment: requireStringField(document, "environment"),
    epoch: requireStringField(document, "epoch"),
    maxExecutions: requireIntegerField(document, "maxExecutions"),
    maxWorstCaseJpy: requireIntegerField(document, "maxWorstCaseJpy"),
    reservedExecutions: requireIntegerField(document, "reservedExecutions"),
    reservedWorstCaseJpy: requireIntegerField(document, "reservedWorstCaseJpy"),
    worstCaseJpyPerExecution: requireIntegerField(document, "worstCaseJpyPerExecution"),
  };
}

function isDisabled(authorization) {
  return (
    authorization.environment === "staging" &&
    authorization.epoch === "disabled" &&
    authorization.activeExecutions === 0 &&
    authorization.maxExecutions === 0 &&
    authorization.maxWorstCaseJpy === 0 &&
    authorization.reservedExecutions === 0 &&
    authorization.reservedWorstCaseJpy === 0 &&
    authorization.worstCaseJpyPerExecution === 0
  );
}

export function isStagingRecoveryReady(document, expectedEpoch) {
  const authorization = parseStagingAuthorizationDocument(document);
  if (authorization === undefined) return true;
  if (isDisabled(authorization)) return true;
  if (
    typeof expectedEpoch !== "string" ||
    !/^phase16-smoke-[a-f0-9]{7,40}-[1-9][0-9]*$/u.test(expectedEpoch) ||
    authorization.environment !== "staging" ||
    authorization.epoch !== expectedEpoch ||
    authorization.maxExecutions !== 1 ||
    authorization.maxWorstCaseJpy !== 250 ||
    !new Set([0, 1]).has(authorization.reservedExecutions) ||
    authorization.reservedWorstCaseJpy !== authorization.reservedExecutions * 250 ||
    authorization.worstCaseJpyPerExecution !== 250
  ) {
    throw new Error("Staging recovery authorization does not belong to this workflow run");
  }
  return authorization.activeExecutions === 0;
}

export function verifyStagingCloudRunSafe({ environmentDocument, executions, jobs }) {
  if (!Array.isArray(jobs) || !Array.isArray(executions)) {
    throw new Error("Staging Cloud Run resource inventory is invalid");
  }
  const authorization = parseStagingAuthorizationDocument(environmentDocument);
  if (
    jobs.length !== 0 ||
    executions.length !== 0 ||
    authorization === undefined ||
    !isDisabled(authorization)
  ) {
    throw new Error("Staging Cloud Run resources have not converged to the disabled zero state");
  }
  return {
    activeExecutions: 0,
    authorization: "disabled",
    executionCount: 0,
    jobCount: 0,
    reservedExecutions: 0,
  };
}
