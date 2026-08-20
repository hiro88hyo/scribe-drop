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

function singleExecutionRecord(executionDocuments, expectedEnvironment) {
  if (
    !Array.isArray(executionDocuments?.documents) ||
    executionDocuments.documents.length !== 1 ||
    executionDocuments.nextPageToken !== undefined
  ) {
    throw new Error("Cloud Run acceptance execution identity is not exact one");
  }
  const record = executionDocuments.documents[0]?.fields?.record?.mapValue?.fields;
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

export function verifyAuthorizedAcceptanceSnapshot(input, expectedEpoch, expectedEnvironment) {
  if (!Array.isArray(input.jobs) || !Array.isArray(input.executions)) {
    throw new Error("Cloud Run acceptance resource inventory is invalid");
  }
  if (
    !new Set(["staging", "production"]).has(expectedEnvironment) ||
    typeof expectedEpoch !== "string" ||
    !/^phase16-smoke-[a-f0-9]{40}-[1-9][0-9]*$/u.test(expectedEpoch)
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
  const record = singleExecutionRecord(input.executionDocuments, expectedEnvironment);
  return {
    complete:
      input.jobs.length === 0 &&
      input.executions.length === 0 &&
      activeExecutions === 0 &&
      isCleanedRecord(record),
  };
}

function timestampField(record, name) {
  const value = stringField({ fields: record }, name);
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds) || new Date(milliseconds).toISOString() !== value) {
    throw new Error("Controller execution timestamp is invalid");
  }
  return milliseconds;
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
  const startedAt = Date.parse(sourceRun?.created_at);
  const completedAt = Date.parse(sourceRun?.updated_at);
  if (!Number.isFinite(startedAt) || !Number.isFinite(completedAt) || completedAt < startedAt) {
    throw new Error("Source staging run timestamps are invalid");
  }
  const record = singleExecutionRecord(input.executionDocuments, "staging");
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
