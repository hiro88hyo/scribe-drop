import assert from "node:assert/strict";
import { test } from "node:test";

import {
  promotePagesCandidate,
  readPagesPromotionState,
  validatePagesPromotionState,
} from "./pages-promotion.mjs";

const expected = {
  branch: "develop",
  commitSha: "a".repeat(40),
  configHash: "b".repeat(64),
  projectName: "scribe-drop-web-staging",
};

function exactState(overrides = {}) {
  return {
    deployments: {
      result: [
        {
          deployment_trigger: {
            metadata: {
              branch: expected.branch,
              commit_hash: expected.commitSha,
            },
          },
          environment: "production",
          is_skipped: false,
          latest_stage: { name: "deploy", status: "success" },
          project_name: expected.projectName,
          uses_functions: true,
          ...overrides,
        },
      ],
      success: true,
    },
    project: {
      result: {
        deployment_configs: {
          production: { wrangler_config_hash: expected.configHash },
        },
        name: expected.projectName,
        production_branch: expected.branch,
      },
      success: true,
    },
  };
}

test("recognizes only the exact successful production Functions deployment", () => {
  assert.deepEqual(validatePagesPromotionState(exactState(), expected), {
    exact: true,
    hasExpectedCommit: true,
    invalidExpectedCommit: false,
    reason: "exact",
  });
  assert.deepEqual(
    validatePagesPromotionState(
      exactState({
        deployment_trigger: {
          metadata: { branch: expected.branch, commit_hash: "c".repeat(40) },
        },
      }),
      expected,
    ),
    {
      exact: false,
      hasExpectedCommit: false,
      invalidExpectedCommit: false,
      reason: "different-candidate",
    },
  );
});

test("rejects an expected deployment that completed without Functions", () => {
  const state = validatePagesPromotionState(exactState({ uses_functions: false }), expected);
  assert.equal(state.invalidExpectedCommit, true);
  assert.equal(state.exact, false);
});

test("skips mutation when the exact candidate is already active", async () => {
  let deployments = 0;
  const result = await promotePagesCandidate(
    {},
    {
      deploy() {
        deployments += 1;
      },
      readState: async () => ({
        exact: true,
        hasExpectedCommit: true,
        invalidExpectedCommit: false,
      }),
    },
  );
  assert.deepEqual(result, { changed: false });
  assert.equal(deployments, 0);
});

test("deploys once and accepts exact read-back", async () => {
  let deployments = 0;
  const states = [
    { exact: false, hasExpectedCommit: false, invalidExpectedCommit: false },
    { exact: true, hasExpectedCommit: true, invalidExpectedCommit: false },
  ];
  const result = await promotePagesCandidate(
    {},
    {
      deploy() {
        deployments += 1;
      },
      readState: async () => states.shift(),
      wait: async () => {},
    },
  );
  assert.deepEqual(result, { changed: true });
  assert.equal(deployments, 1);
});

test("does not repeat an unknown deployment and requires exact read-back", async () => {
  let deployments = 0;
  const states = [
    { exact: false, hasExpectedCommit: false, invalidExpectedCommit: false },
    { exact: true, hasExpectedCommit: true, invalidExpectedCommit: false },
  ];
  const accepted = await promotePagesCandidate(
    {},
    {
      deploy() {
        deployments += 1;
        throw new Error("response lost");
      },
      readState: async () => states.shift(),
      wait: async () => {},
    },
  );
  assert.deepEqual(accepted, { changed: true });
  assert.equal(deployments, 1);

  await assert.rejects(
    promotePagesCandidate(
      {},
      {
        deploy() {
          deployments += 1;
          throw new Error("response lost");
        },
        maximumReadbackAttempts: 2,
        readState: async () => ({
          exact: false,
          hasExpectedCommit: false,
          invalidExpectedCommit: false,
        }),
        wait: async () => {},
      },
    ),
    /outcome is unknown/u,
  );
  assert.equal(deployments, 2);
});

test("reads only fixed Cloudflare Pages API endpoints", async () => {
  const requests = [];
  const configContents = 'name = "staging"\n';
  const configHash = await import("node:crypto").then(({ createHash }) =>
    createHash("sha256").update(configContents).digest("hex"),
  );
  const fetchImplementation = async (url, init) => {
    requests.push({ init, url });
    if (String(url).includes("/deployments?")) {
      return new Response(JSON.stringify(exactState().deployments), { status: 200 });
    }
    const project = exactState().project;
    project.result.deployment_configs.production.wrangler_config_hash = configHash;
    return new Response(JSON.stringify(project), { status: 200 });
  };
  const result = await readPagesPromotionState(
    {
      accountId: "d".repeat(32),
      apiToken: "test-token",
      branch: expected.branch,
      commitSha: expected.commitSha,
      configContents,
      projectName: expected.projectName,
    },
    { fetch: fetchImplementation },
  );
  assert.equal(result.exact, true);
  assert.equal(requests.length, 2);
  for (const request of requests) {
    assert.equal(request.init.method, "GET");
    assert.equal(request.init.redirect, "error");
    assert.match(request.url, /^https:\/\/api\.cloudflare\.com\/client\/v4\/accounts\//u);
  }
});
