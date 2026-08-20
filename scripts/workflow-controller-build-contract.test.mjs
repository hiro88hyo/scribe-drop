import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  verifyControllerBuildPackageContract,
  verifyWorkflowControllerBuildContract,
} from "./workflow-controller-build-contract.mjs";

const packageManifest = readFileSync("package.json", "utf8");
const stagingWorkflow = readFileSync(".github/workflows/deploy-staging-candidate.yml", "utf8");
const productionWorkflow = readFileSync(
  ".github/workflows/deploy-production-candidate.yml",
  "utf8",
);

test("requires a clean-checkout controller dependency closure before aggregate builds", () => {
  assert.equal(
    verifyControllerBuildPackageContract(packageManifest),
    "pnpm --filter '@scribe-drop/gpu-controller...' run build",
  );
});

test("requires dependency-closed controller builds in staging and production", async () => {
  assert.deepEqual(
    await verifyWorkflowControllerBuildContract(stagingWorkflow, {
      expectedBuilds: 3,
      workflowName: "deploy-staging-candidate.yml",
    }),
    [
      "preflight / Validate the exact controller deployment and read-back without mutation",
      "acceptance / Build the controller deployment verifier",
      "recover-acceptance / Build the controller deployment verifier",
    ],
  );
  assert.deepEqual(
    await verifyWorkflowControllerBuildContract(productionWorkflow, {
      expectedBuilds: 2,
      workflowName: "deploy-production-candidate.yml",
    }),
    [
      "cutover / Build verifier and strictly read production foundation",
      "finalize / Build verifier and reconstruct exact production entry configuration",
    ],
  );
});

test("reproduces the rejected clean-checkout staging build regression", async () => {
  const regressed = stagingWorkflow.replace(
    "pnpm run workflow:build:gpu-controller",
    "pnpm --filter @scribe-drop/gpu-controller build",
  );
  await assert.rejects(
    verifyWorkflowControllerBuildContract(regressed, {
      expectedBuilds: 3,
      workflowName: "deploy-staging-candidate.yml",
    }),
    /preflight \/ Validate the exact controller deployment and read-back without mutation must use pnpm run workflow:build:gpu-controller/u,
  );
});

test("rejects the same target-only build in production", async () => {
  const regressed = productionWorkflow.replace(
    "pnpm run workflow:build:gpu-controller",
    "pnpm --filter @scribe-drop/gpu-controller build",
  );
  await assert.rejects(
    verifyWorkflowControllerBuildContract(regressed, {
      expectedBuilds: 2,
      workflowName: "deploy-production-candidate.yml",
    }),
    /cutover \/ Build verifier and strictly read production foundation must use pnpm run workflow:build:gpu-controller/u,
  );
});

test("rejects a package script that omits workspace dependencies", () => {
  const manifest = JSON.parse(packageManifest);
  manifest.scripts["workflow:build:gpu-controller"] =
    "pnpm --filter @scribe-drop/gpu-controller build";
  assert.throws(
    () => verifyControllerBuildPackageContract(JSON.stringify(manifest)),
    /must build the complete dependency closure/u,
  );
});

test("rejects a clean build moved behind aggregate tests", () => {
  const manifest = JSON.parse(packageManifest);
  manifest.scripts.check = manifest.scripts.check.replace(
    "pnpm workflow:build:gpu-controller && pnpm test",
    "pnpm test && pnpm workflow:build:gpu-controller",
  );
  assert.throws(
    () => verifyControllerBuildPackageContract(JSON.stringify(manifest)),
    /before tests or aggregate builds/u,
  );
});
