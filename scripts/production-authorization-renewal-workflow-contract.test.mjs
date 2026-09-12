import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import {
  verifyProductionAuthorizationRenewalManager,
  verifyProductionAuthorizationRenewalWorkflow,
} from "./production-authorization-renewal-workflow-contract.mjs";

const workflow = readFileSync(".github/workflows/deploy-production-candidate.yml", "utf8");
const manager = readFileSync("scripts/manage-production-authorization-renewal.mjs", "utf8");

test("accepts the source-managed resumable renewal workflow", () => {
  assert.doesNotThrow(() => verifyProductionAuthorizationRenewalWorkflow(workflow));
});

test("accepts only the two source-managed remote mutations", () => {
  assert.doesNotThrow(() => verifyProductionAuthorizationRenewalManager(manager));
  assert.throws(() =>
    verifyProductionAuthorizationRenewalManager(
      manager.replace('parameters.set("currentDocument.updateTime", patch.updateTime)', ""),
    ),
  );
  assert.throws(() =>
    verifyProductionAuthorizationRenewalManager(
      manager.replace("const command = process.argv[2];", 'spawnSync("docker build", []);'),
    ),
  );
});

test("rejects a mutation before preflight", () => {
  const changed = workflow.replace(
    "pnpm run production:authorization:renewal preflight",
    "pnpm run production:authorization:renewal apply-service",
  );
  assert.throws(() => verifyProductionAuthorizationRenewalWorkflow(changed));
});

test("rejects a second Service mutation", () => {
  const changed = workflow.replace(
    "pnpm run production:authorization:renewal apply-firestore",
    "pnpm run production:authorization:renewal apply-service",
  );
  assert.throws(() => verifyProductionAuthorizationRenewalWorkflow(changed));
});

test("rejects candidate rebuilds and missing isolated credentials", () => {
  assert.throws(() =>
    verifyProductionAuthorizationRenewalWorkflow(
      workflow.replace(
        "run: pnpm run production:authorization:renewal verify",
        "run: docker build . && pnpm run production:authorization:renewal verify",
      ),
    ),
  );
  assert.throws(() =>
    verifyProductionAuthorizationRenewalWorkflow(
      workflow.replaceAll(
        "GOOGLE_OAUTH_ACCESS_TOKEN: ${{ steps.google-auth.outputs.access_token }}",
        "GOOGLE_OAUTH_ACCESS_TOKEN: missing",
      ),
    ),
  );
});
