import assert from "node:assert/strict";
import { test } from "node:test";

import {
  createStagingCloudRunWafRule,
  findStagingCloudRunWafRule,
  parseStagingCloudRunWafHostname,
  parseStagingCloudRunWafTarget,
  verifyStagingCloudRunWafRule,
} from "./cloud-run-waf-rule.mjs";

const ORIGIN = "https://orchestrator-staging.example.com";

function entrypoint(rules = [createStagingCloudRunWafRule(ORIGIN)]) {
  return { kind: "zone", phase: "http_request_firewall_custom", rules };
}

test("fixes the staging exception to exact internal POST paths and BIC only", () => {
  assert.deepEqual(verifyStagingCloudRunWafRule(entrypoint(), ORIGIN), {
    exactHost: true,
    exactPaths: 5,
    logged: true,
    skippedProducts: ["bic"],
  });
  const rule = createStagingCloudRunWafRule(ORIGIN);
  assert.match(rule.expression, /http\.host eq "orchestrator-staging\.example\.com"/u);
  assert.match(rule.expression, /http\.request\.method eq "POST"/u);
  assert.match(rule.expression, /http\.request\.uri\.query eq ""/u);
  assert.doesNotMatch(rule.expression, /production/u);
});

test("rejects broader products, paths, methods, and disabled logging", () => {
  const cases = [
    { action_parameters: { products: ["bic", "securityLevel"] } },
    {
      expression: createStagingCloudRunWafRule(ORIGIN).expression.replace('eq "POST"', 'eq "GET"'),
    },
    {
      expression: createStagingCloudRunWafRule(ORIGIN).expression.replace(
        '"/internal/cloud-run/ack" ',
        "",
      ),
    },
    { logging: { enabled: false } },
  ];
  for (const change of cases) {
    assert.throws(
      () =>
        verifyStagingCloudRunWafRule(
          entrypoint([{ ...createStagingCloudRunWafRule(ORIGIN), ...change }]),
          ORIGIN,
        ),
      /drifted/u,
    );
  }
});

test("rejects an ambiguous related rule and reports clean absence", () => {
  assert.equal(findStagingCloudRunWafRule(entrypoint([])), null);
  assert.throws(
    () =>
      findStagingCloudRunWafRule(
        entrypoint([
          createStagingCloudRunWafRule(ORIGIN),
          { action: "skip", expression: 'http.request.uri.path contains "/internal/cloud-run/"' },
        ]),
      ),
    /duplicate or ambiguous/u,
  );
});

test("rejects non-staging, production, path-bearing, and credentialed origins", () => {
  assert.equal(parseStagingCloudRunWafHostname(ORIGIN), "orchestrator-staging.example.com");
  for (const origin of [
    "https://orchestrator.example.invalid",
    "https://notstaging.example.invalid",
    "https://orchestrator-production.example.invalid",
    "https://user@orchestrator-staging.example.invalid",
    "https://orchestrator-staging.example.invalid/path",
  ]) {
    assert.throws(() => parseStagingCloudRunWafHostname(origin), /origin is invalid/u);
  }
});

test("requires the staging hostname to belong to an explicit real zone", () => {
  assert.deepEqual(parseStagingCloudRunWafTarget(ORIGIN, "example.com"), {
    hostname: "orchestrator-staging.example.com",
    zoneName: "example.com",
  });
  for (const zoneName of [
    "EXAMPLE.COM",
    "example.invalid",
    "production.example",
    "unrelated.example",
  ]) {
    assert.throws(() => parseStagingCloudRunWafTarget(ORIGIN, zoneName), /zone is invalid/u);
  }
});
