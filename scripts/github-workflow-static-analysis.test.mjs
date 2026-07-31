import assert from "node:assert/strict";
import { test } from "node:test";

import { findRunnerContextBeforeSteps } from "./github-workflow-static-analysis.mjs";

test("rejects runner context in job-level environment", () => {
  const workflow = `
jobs:
  acceptance:
    runs-on: ubuntu-latest
    env:
      EVIDENCE_PATH: \${{ runner.temp }}/evidence.json
    steps:
      - run: true
`;
  assert.deepEqual(findRunnerContextBeforeSteps(workflow), ["acceptance"]);
});

test("accepts runner context in step-level environment", () => {
  const workflow = `
jobs:
  acceptance:
    runs-on: ubuntu-latest
    steps:
      - name: Verify evidence
        env:
          EVIDENCE_PATH: \${{ runner.temp }}/evidence.json
        run: true
`;
  assert.deepEqual(findRunnerContextBeforeSteps(workflow), []);
});

test("reports only invalid jobs in a multi-job workflow", () => {
  const workflow = `
jobs:
  valid:
    runs-on: ubuntu-latest
    steps:
      - run: true
  invalid:
    runs-on: ubuntu-latest
    if: \${{ runner.os == 'Linux' }}
    steps:
      - run: true
`;
  assert.deepEqual(findRunnerContextBeforeSteps(workflow), ["invalid"]);
});
