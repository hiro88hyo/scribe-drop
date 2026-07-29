import assert from "node:assert/strict";
import { test } from "node:test";

import {
  clearRunpodTemplatePorts,
  getRunpodEndpoint,
  listRunpodTemplates,
  setRunpodEndpointCapacity,
  setRunpodEndpointWorkersMax,
  verifyRunpodReleaseReadiness,
} from "./runpod-template-api.mjs";

const apiKey = "dummy_runpod_api_key_for_tests";
const templateId = "template_test";

function jsonResponse(value, status = 200) {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  return {
    async arrayBuffer() {
      return bytes.buffer;
    },
    body: null,
    ok: status >= 200 && status < 300,
    status,
  };
}

test("lists user templates through the fixed official REST boundary", async () => {
  const signal = {};
  const templates = [{ id: templateId, name: "candidate" }];
  const result = await listRunpodTemplates(
    { apiKey },
    {
      createTimeoutSignal(milliseconds) {
        assert.equal(milliseconds, 15_000);
        return signal;
      },
      async fetchImplementation(url, init) {
        assert.equal(
          url.href,
          "https://rest.runpod.io/v1/templates?includeEndpointBoundTemplates=true",
        );
        assert.deepEqual(init, {
          headers: { Authorization: `Bearer ${apiKey}` },
          method: "GET",
          redirect: "error",
          signal,
        });
        return jsonResponse(templates);
      },
    },
  );
  assert.deepEqual(result, templates);
});

test("retries malformed REST template lists with a fixed upper bound", async () => {
  let attempts = 0;
  const retries = [];
  const sleeps = [];
  const result = await listRunpodTemplates(
    { apiKey },
    {
      createTimeoutSignal: () => ({}),
      async fetchImplementation() {
        attempts += 1;
        return jsonResponse(attempts < 3 ? { error: {} } : []);
      },
      onRetry(retry) {
        retries.push(retry);
      },
      async sleep(milliseconds) {
        sleeps.push(milliseconds);
      },
    },
  );
  assert.deepEqual(result, []);
  assert.equal(attempts, 3);
  assert.deepEqual(sleeps, [1_000, 2_000]);
  assert.deepEqual(
    retries.map(({ attempt, command, maximumAttempts }) => ({
      attempt,
      command,
      maximumAttempts,
    })),
    [
      { attempt: 2, command: "template list", maximumAttempts: 3 },
      { attempt: 3, command: "template list", maximumAttempts: 3 },
    ],
  );
});

test("does not retry permanent REST authentication failures", async () => {
  let attempts = 0;
  await assert.rejects(
    listRunpodTemplates(
      { apiKey },
      {
        createTimeoutSignal: () => ({}),
        async fetchImplementation() {
          attempts += 1;
          return jsonResponse({ error: {} }, 401);
        },
        async sleep() {
          throw new Error("Permanent failure must not sleep");
        },
      },
    ),
    /failed after bounded retries/u,
  );
  assert.equal(attempts, 1);
});

test("gets the exact endpoint through the fixed official REST boundary", async () => {
  const endpointId = "endpoint_test";
  const endpoint = { id: endpointId, workers: [] };
  const signal = {};
  const result = await getRunpodEndpoint(
    { apiKey, endpointId },
    {
      createTimeoutSignal(milliseconds) {
        assert.equal(milliseconds, 15_000);
        return signal;
      },
      async fetchImplementation(url, init) {
        assert.equal(
          url.href,
          `https://rest.runpod.io/v1/endpoints/${endpointId}?includeTemplate=true&includeWorkers=true`,
        );
        assert.deepEqual(init, {
          headers: { Authorization: `Bearer ${apiKey}` },
          method: "GET",
          redirect: "error",
          signal,
        });
        return jsonResponse(endpoint);
      },
    },
  );
  assert.deepEqual(result, endpoint);
});

test("rejects an endpoint response for a different resource", async () => {
  await assert.rejects(
    getRunpodEndpoint(
      { apiKey, endpointId: "endpoint_expected" },
      {
        createTimeoutSignal: () => ({}),
        async fetchImplementation() {
          return jsonResponse({ id: "endpoint_other" });
        },
        async sleep() {},
      },
    ),
    /failed after bounded retries/u,
  );
});

test("starts template and endpoint readiness reads in parallel", async () => {
  const pending = [];
  const readiness = verifyRunpodReleaseReadiness(
    { apiKey, endpointId: "endpoint_test" },
    {
      createTimeoutSignal: () => ({}),
      fetchImplementation(url) {
        return new Promise((resolve) => {
          pending.push({ resolve, url });
        });
      },
    },
  );

  await Promise.resolve();
  assert.equal(pending.length, 2);
  for (const request of pending) {
    request.resolve(
      request.url.pathname === "/v1/templates"
        ? jsonResponse([])
        : jsonResponse({ id: "endpoint_test" }),
    );
  }
  await readiness;
});

test("clears ports through the fixed RunPod template API boundary", async () => {
  let bodyCancelled = false;
  const signal = {};
  await clearRunpodTemplatePorts(
    { apiKey, templateId },
    {
      createTimeoutSignal(milliseconds) {
        assert.equal(milliseconds, 60_000);
        return signal;
      },
      async fetchImplementation(url, init) {
        assert.equal(url.href, `https://rest.runpod.io/v1/templates/${templateId}/update`);
        assert.deepEqual(init, {
          body: JSON.stringify({ ports: [] }),
          headers: {
            Authorization: `Bearer ${apiKey}`,
            "Content-Type": "application/json",
          },
          method: "POST",
          redirect: "error",
          signal,
        });
        return {
          body: {
            async cancel() {
              bodyCancelled = true;
            },
          },
          ok: true,
        };
      },
    },
  );
  assert.equal(bodyCancelled, true);
});

test("rejects invalid resource IDs before sending a request", async () => {
  let requests = 0;
  await assert.rejects(
    clearRunpodTemplatePorts(
      { apiKey, templateId: "../unsafe" },
      {
        async fetchImplementation() {
          requests += 1;
          return { ok: true };
        },
      },
    ),
    /template ID is missing or invalid/u,
  );
  assert.equal(requests, 0);
});

test("classifies response loss without exposing the provider error", async () => {
  await assert.rejects(
    clearRunpodTemplatePorts(
      { apiKey, templateId },
      {
        async fetchImplementation() {
          throw new Error("provider response containing sensitive data");
        },
      },
    ),
    (error) => {
      assert.equal(error.message, "RunPod template port update outcome is unknown");
      return true;
    },
  );
});

test("rejects non-success and malformed responses with stable safe errors", async () => {
  await assert.rejects(
    clearRunpodTemplatePorts(
      { apiKey, templateId },
      {
        async fetchImplementation() {
          return { body: null, ok: false };
        },
      },
    ),
    /update was rejected/u,
  );
  await assert.rejects(
    clearRunpodTemplatePorts(
      { apiKey, templateId },
      {
        async fetchImplementation() {
          return { body: null };
        },
      },
    ),
    /invalid response/u,
  );
});

test("sets an endpoint worker maximum through the fixed REST boundary", async () => {
  const endpointId = "endpoint_test";
  const signal = {};
  let bodyCancelled = false;
  await setRunpodEndpointWorkersMax(
    { apiKey, endpointId, workersMax: 0 },
    {
      createTimeoutSignal(milliseconds) {
        assert.equal(milliseconds, 60_000);
        return signal;
      },
      async fetchImplementation(url, init) {
        assert.equal(url.href, `https://rest.runpod.io/v1/endpoints/${endpointId}`);
        assert.deepEqual(init, {
          body: JSON.stringify({ workersMax: 0 }),
          headers: {
            Authorization: `Bearer ${apiKey}`,
            "Content-Type": "application/json",
          },
          method: "PATCH",
          redirect: "error",
          signal,
        });
        return {
          body: {
            async cancel() {
              bodyCancelled = true;
            },
          },
          ok: true,
        };
      },
    },
  );
  assert.equal(bodyCancelled, true);
});

test("validates endpoint worker updates before sending a mutation", async () => {
  let requests = 0;
  for (const input of [
    { endpointId: "../unsafe", workersMax: 0 },
    { endpointId: "endpoint_test", workersMax: -1 },
    { endpointId: "endpoint_test", workersMax: 1.5 },
    { endpointId: "endpoint_test", workersMax: 101 },
  ]) {
    await assert.rejects(
      setRunpodEndpointWorkersMax(
        { apiKey, ...input },
        {
          async fetchImplementation() {
            requests += 1;
            return { ok: true };
          },
        },
      ),
      /missing or invalid/u,
    );
  }
  assert.equal(requests, 0);
});

test("classifies endpoint worker update response loss without retrying", async () => {
  let requests = 0;
  await assert.rejects(
    setRunpodEndpointWorkersMax(
      { apiKey, endpointId: "endpoint_test", workersMax: 0 },
      {
        async fetchImplementation() {
          requests += 1;
          throw new Error("provider response containing sensitive data");
        },
      },
    ),
    (error) => {
      assert.equal(error.message, "RunPod endpoint worker update outcome is unknown");
      return true;
    },
  );
  assert.equal(requests, 1);
});

test("sets ordered GPU fallbacks and data centers through the fixed REST boundary", async () => {
  const endpointId = "endpoint_test";
  const dataCenterIds = ["EU-RO-1", "EU-CZ-1"];
  const gpuTypeIds = [
    "NVIDIA RTX PRO 4500 Blackwell",
    "NVIDIA RTX PRO 4000 Blackwell",
    "NVIDIA L4",
  ];
  const signal = {};
  let bodyCancelled = false;
  await setRunpodEndpointCapacity(
    { apiKey, dataCenterIds, endpointId, gpuTypeIds },
    {
      createTimeoutSignal(milliseconds) {
        assert.equal(milliseconds, 60_000);
        return signal;
      },
      async fetchImplementation(url, init) {
        assert.equal(url.href, `https://rest.runpod.io/v1/endpoints/${endpointId}`);
        assert.deepEqual(init, {
          body: JSON.stringify({ dataCenterIds, gpuTypeIds }),
          headers: {
            Authorization: `Bearer ${apiKey}`,
            "Content-Type": "application/json",
          },
          method: "PATCH",
          redirect: "error",
          signal,
        });
        return {
          body: {
            async cancel() {
              bodyCancelled = true;
            },
          },
          ok: true,
        };
      },
    },
  );
  assert.equal(bodyCancelled, true);
});

test("validates endpoint capacity before sending a mutation", async () => {
  let requests = 0;
  for (const input of [
    {
      dataCenterIds: ["EU-RO-1"],
      endpointId: "../unsafe",
      gpuTypeIds: ["NVIDIA L4"],
    },
    {
      dataCenterIds: ["EU-RO-1"],
      endpointId: "endpoint_test",
      gpuTypeIds: [],
    },
    {
      dataCenterIds: ["EU-RO-1"],
      endpointId: "endpoint_test",
      gpuTypeIds: ["NVIDIA L4", "NVIDIA L4"],
    },
    {
      dataCenterIds: [],
      endpointId: "endpoint_test",
      gpuTypeIds: ["NVIDIA L4"],
    },
    {
      dataCenterIds: ["EU-RO-1", "EU-RO-1"],
      endpointId: "endpoint_test",
      gpuTypeIds: ["NVIDIA L4"],
    },
  ]) {
    await assert.rejects(
      setRunpodEndpointCapacity(
        { apiKey, ...input },
        {
          async fetchImplementation() {
            requests += 1;
            return { ok: true };
          },
        },
      ),
      /missing or invalid/u,
    );
  }
  assert.equal(requests, 0);
});

test("classifies endpoint capacity response loss without retrying", async () => {
  let requests = 0;
  await assert.rejects(
    setRunpodEndpointCapacity(
      {
        apiKey,
        dataCenterIds: ["EU-RO-1"],
        endpointId: "endpoint_test",
        gpuTypeIds: ["NVIDIA L4"],
      },
      {
        async fetchImplementation() {
          requests += 1;
          throw new Error("provider response containing sensitive data");
        },
      },
    ),
    (error) => {
      assert.equal(error.message, "RunPod endpoint capacity update outcome is unknown");
      return true;
    },
  );
  assert.equal(requests, 1);
});
