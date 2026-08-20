function integerField(document, name) {
  const value = document?.fields?.[name]?.integerValue;
  if (typeof value !== "string" || !/^(?:0|[1-9][0-9]*)$/u.test(value)) {
    throw new Error("Controller authorization document is invalid");
  }
  return Number(value);
}

function stringField(document, name) {
  const value = document?.fields?.[name]?.stringValue;
  if (typeof value !== "string") throw new Error("Controller document is invalid");
  return value;
}

function booleanField(fields, name) {
  const value = fields?.[name]?.booleanValue;
  if (typeof value !== "boolean") throw new Error("Controller execution record is invalid");
  return value;
}

function nullField(fields, name) {
  if (fields?.[name]?.nullValue !== null) {
    throw new Error("Controller execution record is invalid");
  }
}

function executionRecords(executionDocuments, expectedEnvironment) {
  if (
    !Array.isArray(executionDocuments?.documents) ||
    executionDocuments.documents.length === 0 ||
    executionDocuments.documents.length > 100 ||
    executionDocuments.nextPageToken !== undefined
  ) {
    throw new Error("Cloud Run acceptance execution inventory is not bounded");
  }
  return executionDocuments.documents.map((document) => {
    const record = document?.fields?.record?.mapValue?.fields;
    if (typeof record !== "object" || record === null) {
      throw new Error("Controller execution record is invalid");
    }
    if (
      stringField({ fields: record }, "environment") !== expectedEnvironment ||
      integerField({ fields: record }, "reservedWorstCaseJpy") !== 250
    ) {
      throw new Error("Controller execution record identity does not match staging acceptance");
    }
    return record;
  });
}

function isCleanedRecord(record) {
  const state = stringField({ fields: record }, "state");
  const cleanupIntent = booleanField(record, "cleanupIntent");
  if (state === "CLEANED") {
    if (!cleanupIntent) throw new Error("Cleaned controller execution lacks cleanup intent");
    nullField(record, "execution");
    nullField(record, "job");
    return true;
  }
  return false;
}

function timestampField(record, name) {
  const value = stringField({ fields: record }, name);
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds) || new Date(milliseconds).toISOString() !== value) {
    throw new Error("Controller execution timestamp is invalid");
  }
  return milliseconds;
}

function githubTimestamp(value) {
  const milliseconds = typeof value === "string" ? Date.parse(value) : Number.NaN;
  if (!Number.isFinite(milliseconds)) throw new Error("Source staging run timestamps are invalid");
  return milliseconds;
}

function requireExactTimestamp(value, name) {
  const milliseconds = typeof value === "string" ? Date.parse(value) : Number.NaN;
  if (!Number.isFinite(milliseconds) || new Date(milliseconds).toISOString() !== value) {
    throw new Error(`${name} is invalid`);
  }
  return value;
}

function executionRecordForRun(executionDocuments, expectedEnvironment, startedAt, completedAt) {
  if (completedAt < startedAt) throw new Error("Source staging run timestamps are invalid");
  const records = executionRecords(executionDocuments, expectedEnvironment);
  const current = records.filter((record) => {
    const createdAt = timestampField(record, "createdAt");
    return createdAt >= startedAt && createdAt <= completedAt;
  });
  if (current.length !== 1) {
    throw new Error("Cloud Run acceptance execution identity is not exact one for the source run");
  }
  for (const record of records) {
    if (record !== current[0] && !isCleanedRecord(record)) {
      throw new Error("Historical controller execution has not been cleaned");
    }
  }
  return current[0];
}

function executionRecordForProductionSmoke(
  executionDocuments,
  expectedEnvironment,
  expectedExecutionHandle,
) {
  if (
    expectedEnvironment !== "production" ||
    typeof expectedExecutionHandle !== "string" ||
    !/^[A-Za-z0-9_-]{43}$/u.test(expectedExecutionHandle)
  ) {
    throw new Error("Production smoke execution identity is invalid");
  }
  const records = executionRecords(executionDocuments, expectedEnvironment);
  const current = records.filter(
    (record) => stringField({ fields: record }, "executionHandle") === expectedExecutionHandle,
  );
  if (current.length !== 1) {
    throw new Error("Controller execution is not exact one for the production smoke execution");
  }
  for (const record of records) {
    if (!isCleanedRecord(record)) {
      throw new Error("Historical controller execution has not been cleaned");
    }
  }
  return current[0];
}

export function verifyAuthorizedAcceptanceSnapshot(
  input,
  expectedEpoch,
  expectedEnvironment,
  sourceRun,
) {
  if (!Array.isArray(input.jobs) || !Array.isArray(input.executions)) {
    throw new Error("Cloud Run acceptance resource inventory is invalid");
  }
  const epochMatch =
    typeof expectedEpoch === "string"
      ? /^phase16-smoke-([a-f0-9]{40})-([1-9][0-9]*)$/u.exec(expectedEpoch)
      : null;
  if (
    !new Set(["staging", "production"]).has(expectedEnvironment) ||
    epochMatch === null ||
    !Number.isSafeInteger(sourceRun?.id) ||
    String(sourceRun.id) !== epochMatch[2]
  ) {
    throw new Error("Cloud Run acceptance epoch is invalid");
  }
  const authorization = input.environmentDocument;
  if (
    stringField(authorization, "environment") !== expectedEnvironment ||
    stringField(authorization, "epoch") !== expectedEpoch ||
    integerField(authorization, "maxExecutions") !== 1 ||
    integerField(authorization, "maxWorstCaseJpy") !== 250 ||
    integerField(authorization, "reservedExecutions") !== 1 ||
    integerField(authorization, "reservedWorstCaseJpy") !== 250 ||
    integerField(authorization, "worstCaseJpyPerExecution") !== 250
  ) {
    throw new Error("Cloud Run acceptance authorization did not consume exact one execution");
  }
  const activeExecutions = integerField(authorization, "activeExecutions");
  if (activeExecutions !== 0 && activeExecutions !== 1) {
    throw new Error("Cloud Run acceptance authorization active count is invalid");
  }
  const record = executionRecordForRun(
    input.executionDocuments,
    expectedEnvironment,
    githubTimestamp(sourceRun.created_at),
    timestampField(authorization?.fields, "validUntil"),
  );
  return {
    complete:
      input.jobs.length === 0 &&
      input.executions.length === 0 &&
      activeExecutions === 0 &&
      isCleanedRecord(record),
  };
}

export function verifyRecoveredAcceptanceSnapshot(input, sourceRun) {
  if (!Array.isArray(input.jobs) || !Array.isArray(input.executions)) {
    throw new Error("Cloud Run acceptance resource inventory is invalid");
  }
  const authorization = input.environmentDocument;
  if (
    input.jobs.length !== 0 ||
    input.executions.length !== 0 ||
    stringField(authorization, "environment") !== "staging" ||
    stringField(authorization, "epoch") !== "disabled" ||
    integerField(authorization, "activeExecutions") !== 0 ||
    integerField(authorization, "maxExecutions") !== 0 ||
    integerField(authorization, "maxWorstCaseJpy") !== 0 ||
    integerField(authorization, "reservedExecutions") !== 0 ||
    integerField(authorization, "reservedWorstCaseJpy") !== 0 ||
    integerField(authorization, "worstCaseJpyPerExecution") !== 0
  ) {
    throw new Error("Recovered Cloud Run acceptance is not in the disabled zero state");
  }
  const startedAt = githubTimestamp(sourceRun?.created_at);
  const completedAt = githubTimestamp(sourceRun?.updated_at);
  const record = executionRecordForRun(input.executionDocuments, "staging", startedAt, completedAt);
  if (!isCleanedRecord(record)) {
    throw new Error("Recovered Cloud Run acceptance execution is not CLEANED");
  }
  const createdAt = timestampField(record, "createdAt");
  const updatedAt = timestampField(record, "updatedAt");
  if (
    createdAt < startedAt ||
    createdAt > completedAt ||
    updatedAt < createdAt ||
    updatedAt > completedAt
  ) {
    throw new Error("Recovered Cloud Run acceptance execution is not bound to the source run");
  }
  return {
    activeExecutions: 0,
    executionCount: 0,
    jobCount: 0,
    providerRecord: "CLEANED",
    reservedExecutions: 1,
  };
}

export function verifyProductionFinalizeSnapshot(input, expected, sourceRun) {
  if (!Array.isArray(input.jobs) || !Array.isArray(input.executions)) {
    throw new Error("Production finalize resource inventory is invalid");
  }
  if (input.jobs.length !== 0 || input.executions.length !== 0) {
    throw new Error("Production finalize provider resources have not converged");
  }
  const authorization = input.environmentDocument;
  if (
    stringField(authorization, "environment") !== "production" ||
    integerField(authorization, "activeExecutions") !== 0
  ) {
    throw new Error("Production finalize authorization state is invalid");
  }
  const record = executionRecordForProductionSmoke(
    input.executionDocuments,
    "production",
    expected?.smokeExecutionHandle,
  );
  if (!isCleanedRecord(record)) {
    throw new Error("Production finalize execution record is not CLEANED");
  }
  const authorizationMode = expected?.stage?.split("-")[0];
  if (authorizationMode === "smoke") {
    const epochMatch =
      typeof expected.smokeEpoch === "string"
        ? /^phase16-smoke-([a-f0-9]{40})-([1-9][0-9]*)$/u.exec(expected.smokeEpoch)
        : null;
    if (
      epochMatch === null ||
      String(sourceRun?.id) !== epochMatch[2] ||
      stringField(authorization, "epoch") !== expected.smokeEpoch ||
      integerField(authorization, "maxExecutions") !== 1 ||
      integerField(authorization, "maxWorstCaseJpy") !== 250 ||
      integerField(authorization, "reservedExecutions") !== 1 ||
      integerField(authorization, "reservedWorstCaseJpy") !== 250 ||
      integerField(authorization, "worstCaseJpyPerExecution") !== 250
    ) {
      throw new Error("Production smoke authorization did not consume exact one execution");
    }
  } else if (authorizationMode === "disabled") {
    if (
      stringField(authorization, "epoch") !== "disabled" ||
      integerField(authorization, "maxExecutions") !== 0 ||
      integerField(authorization, "maxWorstCaseJpy") !== 0 ||
      integerField(authorization, "reservedExecutions") !== 0 ||
      integerField(authorization, "reservedWorstCaseJpy") !== 0 ||
      integerField(authorization, "worstCaseJpyPerExecution") !== 0
    ) {
      throw new Error("Production disabled finalize state is invalid");
    }
  } else if (authorizationMode === "operational") {
    const epochMatch =
      typeof expected.operationalEpoch === "string"
        ? /^phase16-operational-([a-f0-9]{40})-([1-9][0-9]*)$/u.exec(expected.operationalEpoch)
        : null;
    if (
      epochMatch === null ||
      String(sourceRun?.id) !== epochMatch[2] ||
      stringField(authorization, "epoch") !== expected.operationalEpoch ||
      integerField(authorization, "maxExecutions") !== expected.maxExecutions ||
      integerField(authorization, "maxWorstCaseJpy") !== expected.maxWorstCaseJpy ||
      integerField(authorization, "reservedExecutions") !== 0 ||
      integerField(authorization, "reservedWorstCaseJpy") !== 0 ||
      integerField(authorization, "worstCaseJpyPerExecution") !== 250 ||
      stringField(authorization, "validUntil") !==
        requireExactTimestamp(expected.validUntil, "Production operational expiry")
    ) {
      throw new Error("Production operational finalize state is invalid");
    }
  } else {
    throw new Error("Production finalize entry stage is invalid");
  }
  return {
    activeExecutions: 0,
    authorization: authorizationMode,
    executionCount: 0,
    jobCount: 0,
    providerRecord: "CLEANED",
    stage: expected.stage,
  };
}
