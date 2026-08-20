import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  applyProductionFinalizeAction,
  productionFinalizeAdmission,
  productionFinalizeAuthorization,
  productionFinalizePlan,
  productionFinalizeStages,
  requireProductionFinalizeStage,
} from "./production-finalize-state.mjs";

const expected = Object.freeze({
  "disabled-paused": ["authorize-operational", "activate-admission"],
  "operational-active": [],
  "operational-paused": ["activate-admission"],
  "smoke-active": [
    "pause-admission",
    "disable-smoke",
    "authorize-operational",
    "activate-admission",
  ],
  "smoke-paused": ["disable-smoke", "authorize-operational", "activate-admission"],
});

test("defines an exact convergent plan for every finalize prefix state", () => {
  assert.deepEqual([...productionFinalizeStages].sort(), Object.keys(expected).sort());
  for (const stage of productionFinalizeStages) {
    assert.deepEqual(productionFinalizePlan(stage), expected[stage]);
  }
});

test("every injected post-mutation failure resumes from a declared prefix state", () => {
  for (const initial of productionFinalizeStages) {
    let current = initial;
    for (const action of productionFinalizePlan(initial)) {
      current = applyProductionFinalizeAction(current, action);
      assert.ok(productionFinalizeStages.includes(current));
      assert.doesNotThrow(() => productionFinalizePlan(current));
    }
    assert.equal(current, "operational-active");
  }
});

test("binds each state to one exact admission and authorization pair", () => {
  assert.deepEqual(
    productionFinalizeStages.map((stage) => [
      stage,
      productionFinalizeAdmission(stage),
      productionFinalizeAuthorization(stage),
    ]),
    [
      ["smoke-active", "active", "smoke"],
      ["smoke-paused", "paused", "smoke"],
      ["disabled-paused", "paused", "disabled"],
      ["operational-paused", "paused", "operational"],
      ["operational-active", "active", "operational"],
    ],
  );
  assert.throws(() => requireProductionFinalizeStage("unknown"), /entry stage/u);
  assert.throws(
    () => applyProductionFinalizeAction("smoke-active", "disable-smoke"),
    /transition/u,
  );
});

test("entry verifier is read-only and bounded", () => {
  const source = readFileSync(
    new URL("./verify-production-finalize-entry.mjs", import.meta.url),
    "utf8",
  );
  assert.match(source, /runGcloud\(\["run", "jobs", "list"/u);
  assert.match(source, /runGcloud\(\["run", "jobs", "executions", "list"/u);
  assert.match(source, /scribe_drop_controller_executions\?pageSize=100/u);
  assert.match(source, /createProductionSmokeD1Arguments/u);
  assert.match(source, /parseProductionSmokeObservation/u);
  assert.match(source, /redirect: "manual"/u);
  assert.doesNotMatch(source, /method:\s*"(?:PATCH|POST|PUT|DELETE)"/u);
  assert.doesNotMatch(source, /jobs", "(?:create|deploy|execute|delete)"/u);
});
