import process from "node:process";

import { validateProductionPromotionInputs } from "./production-promotion-inputs.mjs";

try {
  const result = validateProductionPromotionInputs({
    candidateCommitSha: process.env.CANDIDATE_COMMIT_SHA,
    cutoverRunId: process.env.CUTOVER_RUN_ID,
    finalizeEntryStage: process.env.PRODUCTION_FINALIZE_ENTRY_STAGE,
    operation: process.env.PRODUCTION_OPERATION,
    operationalMaxExecutions: process.env.OPERATIONAL_MAX_EXECUTIONS,
    operationalMaxWorstCaseJpy: process.env.OPERATIONAL_MAX_WORST_CASE_JPY,
    operationalValidUntil: process.env.OPERATIONAL_VALID_UNTIL,
    productionSmokeJobId: process.env.PRODUCTION_SMOKE_JOB_ID,
    preflightOnly: process.env.PRODUCTION_PREFLIGHT_ONLY,
    preflightRunId: process.env.PRODUCTION_PREFLIGHT_RUN_ID,
    previousProductionRunId: process.env.PREVIOUS_PRODUCTION_RUN_ID,
    stagingRunId: process.env.STAGING_RUN_ID,
  });
  console.log(`Verified production ${result.operation} inputs.`);
} catch (error) {
  console.error(error instanceof Error ? error.message : "Production promotion input is invalid");
  process.exitCode = 1;
}
