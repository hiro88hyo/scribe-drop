import { readFileSync } from "node:fs";

import { verifyProductionWorkflowStateContract } from "./production-workflow-state-contract.mjs";

try {
  const result = verifyProductionWorkflowStateContract(
    readFileSync(".github/workflows/deploy-production-candidate.yml", "utf8"),
  );
  console.log(`Production workflow state contract: ${JSON.stringify(result)}`);
} catch (error) {
  console.error(error instanceof Error ? error.message : "Production workflow contract is invalid");
  process.exitCode = 1;
}
