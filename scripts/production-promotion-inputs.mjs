const runIdPattern = /^[1-9][0-9]*$/u;
const commitShaPattern = /^[a-f0-9]{40}$/u;
const ulidPattern = /^[0-9A-HJKMNP-TV-Z]{26}$/u;

function positiveInteger(value, name) {
  if (typeof value !== "string" || !/^[1-9][0-9]*$/u.test(value)) {
    throw new Error(`${name} is invalid`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw new Error(`${name} is invalid`);
  return parsed;
}

export function validateProductionPromotionInputs(input, now = new Date()) {
  if (!runIdPattern.test(input.stagingRunId) || !commitShaPattern.test(input.candidateCommitSha)) {
    throw new Error("Production candidate identity is invalid");
  }
  if (input.preflightOnly !== "true" && input.preflightOnly !== "false") {
    throw new Error("Production preflight mode is invalid");
  }
  if (input.operation === "cutover") {
    if (
      input.cutoverRunId !== "0" ||
      input.productionSmokeJobId !== "none" ||
      input.operationalMaxExecutions !== "0" ||
      input.operationalMaxWorstCaseJpy !== "0" ||
      input.operationalValidUntil !== "1970-01-01T00:00:00.000Z" ||
      (input.preflightOnly === "true"
        ? input.preflightRunId !== "0"
        : !runIdPattern.test(input.preflightRunId))
    ) {
      throw new Error("Cutover must not include finalize-only inputs");
    }
    return {
      candidateCommitSha: input.candidateCommitSha,
      operation: "cutover",
      preflightOnly: input.preflightOnly === "true",
      preflightRunId: input.preflightRunId,
      stagingRunId: input.stagingRunId,
    };
  }
  if (input.operation !== "finalize") {
    throw new Error("Production promotion operation is invalid");
  }
  if (input.preflightOnly === "true") {
    throw new Error("Finalize cannot run in preflight-only mode");
  }
  if (input.preflightRunId !== "0") {
    throw new Error("Finalize must not include a preflight run ID");
  }
  if (!runIdPattern.test(input.cutoverRunId) || !ulidPattern.test(input.productionSmokeJobId)) {
    throw new Error("Finalize evidence identity is invalid");
  }
  const maxExecutions = positiveInteger(
    input.operationalMaxExecutions,
    "Operational maximum executions",
  );
  const maxWorstCaseJpy = positiveInteger(
    input.operationalMaxWorstCaseJpy,
    "Operational maximum worst-case JPY",
  );
  if (maxExecutions > 20 || maxWorstCaseJpy !== maxExecutions * 250) {
    throw new Error(
      "Operational budget must equal 250 JPY per execution and at most 20 executions",
    );
  }
  const expiry = new Date(input.operationalValidUntil);
  if (
    !Number.isFinite(now.getTime()) ||
    !Number.isFinite(expiry.getTime()) ||
    expiry.toISOString() !== input.operationalValidUntil ||
    expiry.getTime() <= now.getTime() + 30 * 60 * 1_000 ||
    expiry.getTime() > now.getTime() + 24 * 60 * 60 * 1_000
  ) {
    throw new Error("Operational authorization expiry is outside the reviewed window");
  }
  return {
    cutoverRunId: input.cutoverRunId,
    candidateCommitSha: input.candidateCommitSha,
    maxExecutions,
    maxWorstCaseJpy,
    operation: "finalize",
    preflightOnly: false,
    preflightRunId: "0",
    productionSmokeJobId: input.productionSmokeJobId,
    stagingRunId: input.stagingRunId,
    validUntil: expiry.toISOString(),
  };
}
