import assert from "node:assert/strict";
import test from "node:test";

import { readStagingL4Quota, stagingL4QuotaUrl } from "./staging-cloud-run-quota-client.mjs";

const token = "A".repeat(32);

test("reads the exact staging L4 quota through the Cloud Quotas API", async () => {
  let observed;
  const quota = { quotaId: "NvidiaL4GpuAllocNoZonalRedundancyPerProjectRegion" };
  const result = await readStagingL4Quota(token, async (url, init) => {
    observed = { init, url };
    return new Response(JSON.stringify(quota), { status: 200 });
  });

  assert.deepEqual(result, quota);
  assert.equal(observed.url, stagingL4QuotaUrl);
  assert.equal(observed.init.redirect, "error");
  assert.deepEqual(observed.init.headers, {
    accept: "application/json",
    authorization: `Bearer ${token}`,
  });
});

test("rejects missing authentication before issuing a request", async () => {
  let called = false;
  await assert.rejects(
    readStagingL4Quota("", async () => {
      called = true;
      return new Response("{}", { status: 200 });
    }),
    /authentication is missing or invalid/u,
  );
  assert.equal(called, false);
});

test("reports only the safe response status when quota read is denied", async () => {
  await assert.rejects(
    readStagingL4Quota(
      token,
      async () => new Response('{"error":{"message":"sensitive"}}', { status: 403 }),
    ),
    /^Error: Staging L4 quota read failed: 403$/u,
  );
});

test("rejects an invalid quota response", async () => {
  await assert.rejects(
    readStagingL4Quota(token, async () => new Response("not-json", { status: 200 })),
    /quota response was invalid/u,
  );
});
