import process from "node:process";

import { readAndVerifyStagingAccessControlPlane } from "./staging-access-control-plane.mjs";

try {
  const result = await readAndVerifyStagingAccessControlPlane();
  console.log(
    `Staging Access control plane verified: ${String(result.applications)} applications, ${String(
      result.serviceAuthPolicies,
    )} exact Service Auth policies`,
  );
} catch (error) {
  console.error(
    error instanceof Error ? error.message : "Staging Access control-plane verification failed",
  );
  process.exitCode = 1;
}
