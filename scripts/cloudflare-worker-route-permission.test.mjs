import assert from "node:assert/strict";
import { test } from "node:test";

import { verifyCloudflareWorkerRoutePermission } from "./cloudflare-worker-route-permission.mjs";

const input = {
  accountId: "a".repeat(32),
  apiToken: "token_value_that_is_long_enough",
  orchestratorOrigin: "https://worker.example.test",
};

function response(result, status = 200) {
  return new Response(JSON.stringify({ result, success: status === 200 }), {
    headers: { "Content-Type": "application/json" },
    status,
  });
}

test("verifies Zone Read and Workers Routes Read without exposing resource values", async () => {
  const requests = [];
  const fetchImplementation = async (url) => {
    requests.push(url);
    if (url.pathname === "/client/v4/zones") {
      const name = url.searchParams.get("name");
      return response(
        name === "example.test"
          ? [
              {
                account: { id: input.accountId },
                id: "b".repeat(32),
                name,
                status: "active",
              },
            ]
          : [],
      );
    }
    if (url.pathname === `/client/v4/zones/${"b".repeat(32)}/workers/routes`) {
      return response([{ pattern: "worker.example.test", script: "worker" }]);
    }
    return response([], 404);
  };

  await verifyCloudflareWorkerRoutePermission(input, fetchImplementation);

  assert.deepEqual(
    requests.map((request) => request.pathname),
    ["/client/v4/zones", "/client/v4/zones", `/client/v4/zones/${"b".repeat(32)}/workers/routes`],
  );
});

test("fails before route inspection when Zone Read is unavailable", async () => {
  await assert.rejects(
    verifyCloudflareWorkerRoutePermission(input, async () => response([], 403)),
    /Zone Read capability is unavailable/u,
  );
});

test("fails before deployment when Workers Routes Read is unavailable", async () => {
  await assert.rejects(
    verifyCloudflareWorkerRoutePermission(input, async (url) =>
      url.pathname === "/client/v4/zones"
        ? response([
            {
              account: { id: input.accountId },
              id: "b".repeat(32),
              name: url.searchParams.get("name"),
              status: "active",
            },
          ])
        : response([], 403),
    ),
    /Workers Routes Read capability is unavailable/u,
  );
});

test("rejects invalid account, token, and origin inputs without network access", async () => {
  for (const changed of [
    { ...input, accountId: "invalid" },
    { ...input, apiToken: "short" },
    { ...input, orchestratorOrigin: "http://worker.example.test" },
  ]) {
    let called = false;
    await assert.rejects(
      verifyCloudflareWorkerRoutePermission(changed, async () => {
        called = true;
        return response([]);
      }),
      /invalid/u,
    );
    assert.equal(called, false);
  }
});
