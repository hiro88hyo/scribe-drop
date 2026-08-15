const runIdPattern = /^[1-9][0-9]*$/u;
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
  if (!runIdPattern.test(input.stagingRunId)) {
    throw new Error("Staging run ID is invalid");
  }
  if (input.operation === "cutover") {
    if (
      input.cutoverRunId !== "0" ||
      input.productionSmokeJobId !== "none" ||
      input.operationalMaxExecutions !== "0" ||
      input.operationalMaxWorstCaseJpy !== "0" ||
      input.operationalValidUntil !== "1970-01-01T00:00:00.000Z"
    ) {
      throw new Error("Cutover must not include finalize-only inputs");
    }
    return { operation: "cutover", stagingRunId: input.stagingRunId };
  }
  if (input.operation !== "finalize") {
    throw new Error("Production promotion operation is invalid");
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
    maxExecutions,
    maxWorstCaseJpy,
    operation: "finalize",
    productionSmokeJobId: input.productionSmokeJobId,
    stagingRunId: input.stagingRunId,
    validUntil: expiry.toISOString(),
  };
}
