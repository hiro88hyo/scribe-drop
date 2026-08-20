import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const workflow = readFileSync(
  path.resolve(scriptDirectory, "../.github/workflows/deploy-production-candidate.yml"),
  "utf8",
);

function workflowStep(contents, stepName) {
  const marker = `      - name: ${stepName}\n`;
  const start = contents.indexOf(marker);
  assert.notEqual(start, -1, `missing workflow step: ${stepName}`);
  const remainder = contents.slice(start + marker.length);
  const nextStep = remainder.search(/^ {6}- name: /mu);
  return nextStep === -1
    ? contents.slice(start)
    : contents.slice(start, start + marker.length + nextStep);
}

test("runs the source-managed contract before production input and remote verification", () => {
  const contract = workflow.indexOf("pnpm run production:dispatch:verify");
  const inputVerification = workflow.indexOf("pnpm run production:promotion:inputs:verify");
  const firstRemoteRead = workflow.indexOf('gh api "repos/${GITHUB_REPOSITORY}/actions/runs/');

  assert.notEqual(contract, -1);
  assert.ok(contract < inputVerification);
  assert.ok(contract < firstRemoteRead);
});

test("binds every discovered cleanup prerequisite in the finalize step", () => {
  const cleanupStep = workflowStep(
    workflow,
    "Verify production smoke and exact provider cleanup before mutation",
  );

  assert.match(cleanupStep, /GOOGLE_OAUTH_ACCESS_TOKEN:/u);
  assert.match(
    cleanupStep,
    /SCRIBE_DROP_CLOUD_RUN_AUTHORIZATION_EPOCH: phase16-smoke-\$\{\{ inputs\.candidate_commit_sha \}\}-\$\{\{ inputs\.cutover_run_id \}\}/u,
  );
  assert.match(
    cleanupStep,
    /pnpm run cloud-run:acceptance:clean production "\$\{CUTOVER_RUN_PATH\}"/u,
  );
});
