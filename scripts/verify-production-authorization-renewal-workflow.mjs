import { readFileSync } from "node:fs";

import {
  verifyProductionAuthorizationRenewalManager,
  verifyProductionAuthorizationRenewalWorkflow,
} from "./production-authorization-renewal-workflow-contract.mjs";

verifyProductionAuthorizationRenewalWorkflow(
  readFileSync(".github/workflows/deploy-production-candidate.yml", "utf8"),
);
verifyProductionAuthorizationRenewalManager(
  readFileSync("scripts/manage-production-authorization-renewal.mjs", "utf8"),
);
process.stdout.write("Production authorization renewal workflow contract is valid.\n");
