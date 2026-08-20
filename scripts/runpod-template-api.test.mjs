import assert from "node:assert/strict";
import { test } from "node:test";

import {
  clearRunpodTemplatePorts,
  getRunpodEndpoint,
  getRunpodEndpointCapacity,
  getRunpodEndpointHealth,
  getRunpodEndpointPlacement,
  listRunpodTemplates,
  setRunpodEndpointDataCenters,
  setRunpodEndpointGpuTypes,
  setRunpodEndpointWorkersMax,
  setRunpodEndpointWorkersMin,
  verifyRunpodReleaseReadiness,
  verifyRunpodServerlessGpuPools,
  verifyRunpodServerlessGpuTypes,
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

function serverlessOpenApi(gpuTypeIds) {
  return {
    components: {
      schemas: {
        EndpointCreateInput: { properties: { gpuTypeIds: { items: { enum: gpuTypeIds } } } },
        EndpointUpdateInput: { properties: { gpuTypeIds: { items: { enum: gpuTypeIds } } } },
      },
    },
  };
}

function serverlessGpuPools(pools, errors = []) {
  return { data: { serverlessGpuPools: pools }, errors };
}

test("verifies fixed GPU fallbacks against both public Serverless OpenAPI inputs", async () => {
  const gpuTypeIds = [
    "NVIDIA GeForce RTX 5090",
    "NVIDIA GeForce RTX 4090",
    "NVIDIA RTX PRO 6000 Blackwell Server Edition",
  ];
  const signal = {};
  let observed;
  const result = await verifyRunpodServerlessGpuTypes(
    { gpuTypeIds },
    {
      createTimeoutSignal(milliseconds) {
        assert.equal(milliseconds, 15_000);
        return signal;
      },
      async fetchImplementation(url, init) {
        observed = { init, url };
        return jsonResponse(serverlessOpenApi(gpuTypeIds));
      },
    },
  );
  assert.deepEqual(result, { configuredCount: 3 });
  assert.equal(observed.url.href, "https://rest.runpod.io/v1/openapi.json");
  assert.deepEqual(observed.init.headers, {});
  assert.equal(observed.init.redirect, "error");
  assert.equal(observed.init.signal, signal);
});

test("rejects an inventory GPU that either Serverless OpenAPI input does not support", async () => {
  const gpuTypeIds = ["NVIDIA RTX PRO 4500 Blackwell"];
  for (const schemaName of ["EndpointCreateInput", "EndpointUpdateInput"]) {
    const openApi = serverlessOpenApi(gpuTypeIds);
    openApi.components.schemas[schemaName].properties.gpuTypeIds.items.enum = ["NVIDIA L4"];
    await assert.rejects(
      verifyRunpodServerlessGpuTypes(
        { gpuTypeIds },
        {
          async fetchImplementation() {
            return jsonResponse(openApi);
          },
          async sleep() {},
        },
      ),
      /failed after bounded retries/u,
    );
  }
});

test("verifies every fixed GPU maps to a distinct authenticated Serverless pool", async () => {
  const gpuTypeIds = [
    "NVIDIA GeForce RTX 5090",
    "NVIDIA GeForce RTX 4090",
    "NVIDIA RTX PRO 6000 Blackwell Server Edition",
  ];
  const signal = {};
  let observed;
  const result = await verifyRunpodServerlessGpuPools(
    { apiKey, gpuTypeIds },
    {
      createTimeoutSignal(milliseconds) {
        assert.equal(milliseconds, 15_000);
        return signal;
      },
      async fetchImplementation(url, init) {
        observed = { body: JSON.parse(init.body), init, url };
        return jsonResponse(
          serverlessGpuPools([
            { gpuTypeIds: [gpuTypeIds[1]], id: "ADA_24" },
            { gpuTypeIds: [gpuTypeIds[0]], id: "ADA_32_PRO" },
            { gpuTypeIds: [gpuTypeIds[2]], id: "BLACKWELL_96" },
          ]),
        );
      },
    },
  );
  assert.deepEqual(result, { configuredCount: 3, poolCount: 3 });
  assert.equal(observed.url.href, "https://api.runpod.io/graphql");
  assert.deepEqual(observed.init.headers, {
    Authorization: `Bearer ${apiKey}`,
    "Content-Type": "application/json",
  });
  assert.equal(observed.init.method, "POST");
  assert.match(observed.body.query, /serverlessGpuPools/u);
  assert.equal(observed.init.redirect, "error");
  assert.equal(observed.init.signal, signal);
});

test("rejects GPUs missing from Serverless pools and duplicate pool mappings", async () => {
  const cases = [
    {
      gpuTypeIds: ["NVIDIA RTX PRO 4500 Blackwell"],
      pools: [{ gpuTypeIds: ["NVIDIA GeForce RTX 5090"], id: "ADA_32_PRO" }],
    },
    {
      gpuTypeIds: ["NVIDIA GeForce RTX 5090", "NVIDIA RTX PRO 4500 Blackwell"],
      pools: [
        {
          gpuTypeIds: ["NVIDIA GeForce RTX 5090", "NVIDIA RTX PRO 4500 Blackwell"],
          id: "ADA_32_PRO",
        },
      ],
    },
  ];
  for (const testCase of cases) {
    await assert.rejects(
      verifyRunpodServerlessGpuPools(
        { apiKey, gpuTypeIds: testCase.gpuTypeIds },
        {
          async fetchImplementation() {
            return jsonResponse(serverlessGpuPools(testCase.pools));
          },
          async sleep() {},
        },
      ),
      /failed after bounded retries/u,
    );
  }
});

test("rejects malformed or errored Serverless GPU pool responses", async () => {
  for (const response of [
    serverlessGpuPools([], [{ message: "provider error" }]),
    serverlessGpuPools([{ gpuTypeIds: [], id: "ADA_24" }]),
    serverlessGpuPools([
      { gpuTypeIds: ["NVIDIA GeForce RTX 4090"], id: "ADA_24" },
      { gpuTypeIds: ["NVIDIA GeForce RTX 5090"], id: "ADA_24" },
    ]),
  ]) {
    await assert.rejects(
      verifyRunpodServerlessGpuPools(
        { apiKey, gpuTypeIds: ["NVIDIA GeForce RTX 4090"] },
        {
          async fetchImplementation() {
            return jsonResponse(response);
          },
          async sleep() {},
        },
      ),
      /failed after bounded retries/u,
    );
  }
});

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

test("reads endpoint placement through the fixed Console-equivalent GraphQL boundary", async () => {
  const endpointId = "endpoint_test";
  const signal = {};
  const result = await getRunpodEndpointPlacement(
    { apiKey, endpointId },
    {
      createTimeoutSignal(milliseconds) {
        assert.equal(milliseconds, 15_000);
        return signal;
      },
      async fetchImplementation(url, init) {
        assert.equal(url.href, "https://api.runpod.io/graphql");
        assert.deepEqual(init, {
          body: JSON.stringify({
            query: `query ScribeDropEndpointPlacement($id: String!) {
  myself {
    endpoint(id: $id) {
      id
      locations
      compliance
    }
  }
}`,
            variables: { id: endpointId },
          }),
          headers: {
            Authorization: `Bearer ${apiKey}`,
            "Content-Type": "application/json",
          },
          method: "POST",
          redirect: "error",
          signal,
        });
        return jsonResponse({
          data: {
            myself: {
              endpoint: {
                compliance: [],
                id: endpointId,
                locations: "EUR-IS-1,EU-RO-1",
              },
            },
          },
        });
      },
    },
  );
  assert.deepEqual(result, {
    compliance: [],
    dataCenterIds: ["EUR-IS-1", "EU-RO-1"],
    id: endpointId,
  });
});

test("combines REST GPU capacity with exact GraphQL placement", async () => {
  const endpointId = "endpoint_test";
  const result = await getRunpodEndpointCapacity(
    { apiKey, endpointId },
    {
      createTimeoutSignal: () => ({}),
      async fetchImplementation(url) {
        if (url.origin === "https://rest.runpod.io") {
          return jsonResponse({
            gpuTypeIds: [
              "NVIDIA GeForce RTX 5090",
              "NVIDIA GeForce RTX 4090",
              "NVIDIA RTX PRO 6000 Blackwell Server Edition",
            ],
            id: endpointId,
          });
        }
        return jsonResponse({
          data: {
            myself: {
              endpoint: {
                compliance: [],
                id: endpointId,
                locations: "EUR-IS-1,EU-RO-1",
              },
            },
          },
        });
      },
    },
  );
  assert.deepEqual(result, {
    compliance: [],
    dataCenterIds: ["EUR-IS-1", "EU-RO-1"],
    gpuTypeIds: [
      "NVIDIA GeForce RTX 5090",
      "NVIDIA GeForce RTX 4090",
      "NVIDIA RTX PRO 6000 Blackwell Server Edition",
    ],
    id: endpointId,
  });
});

test("rejects missing, malformed, or contradictory endpoint placement", async () => {
  for (const endpoint of [
    { compliance: [], id: "endpoint_test", locations: null },
    { compliance: [], id: "endpoint_test" },
    { compliance: ["Any"], id: "endpoint_test", locations: "EUR-IS-1" },
    { compliance: [], id: "endpoint_other", locations: "EUR-IS-1" },
    { compliance: [], id: "endpoint_test", locations: "unsafe" },
  ]) {
    const result = getRunpodEndpointPlacement(
      { apiKey, endpointId: "endpoint_test" },
      {
        createTimeoutSignal: () => ({}),
        async fetchImplementation() {
          return jsonResponse({
            data: { myself: { endpoint } },
          });
        },
        async sleep() {},
      },
    );
    if (Object.hasOwn(endpoint, "locations") && endpoint.locations === null) {
      assert.deepEqual(await result, {
        compliance: [],
        dataCenterIds: [],
        id: "endpoint_test",
      });
    } else {
      await assert.rejects(result, /failed after bounded retries/u);
    }
  }
});

test("reads only bounded job and worker counters from endpoint health", async () => {
  const endpointId = "endpoint_test";
  const signal = {};
  const result = await getRunpodEndpointHealth(
    { apiKey, endpointId },
    {
      createTimeoutSignal(milliseconds) {
        assert.equal(milliseconds, 15_000);
        return signal;
      },
      async fetchImplementation(url, init) {
        assert.equal(url.href, `https://api.runpod.ai/v2/${endpointId}/health`);
        assert.deepEqual(init, {
          headers: { Authorization: `Bearer ${apiKey}` },
          method: "GET",
          redirect: "error",
          signal,
        });
        return jsonResponse({
          jobs: { inProgress: 1, inQueue: 7 },
          workers: {
            idle: 0,
            initializing: 1,
            ready: 2,
            running: 0,
            throttled: 0,
            unhealthy: 0,
          },
        });
      },
    },
  );
  assert.deepEqual(result, {
    jobs: {
      inProgress: 1,
      inQueue: 7,
    },
    workers: {
      idle: 0,
      initializing: 1,
      ready: 2,
      running: 0,
      throttled: 0,
      unhealthy: 0,
    },
  });
});

test("rejects malformed endpoint health counters", async () => {
  await assert.rejects(
    getRunpodEndpointHealth(
      { apiKey, endpointId: "endpoint_test" },
      {
        createTimeoutSignal: () => ({}),
        async fetchImplementation() {
          return jsonResponse({ jobs: {}, workers: { running: -1 } });
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
  assert.equal(pending.length, 3);
  for (const request of pending) {
    request.resolve(
      request.url.pathname === "/v1/templates"
        ? jsonResponse([])
        : request.url.origin === "https://rest.runpod.io"
          ? jsonResponse({
              gpuTypeIds: ["NVIDIA GeForce RTX 5090"],
              id: "endpoint_test",
            })
          : jsonResponse({
              data: {
                myself: {
                  endpoint: {
                    compliance: [],
                    id: "endpoint_test",
                    locations: "EUR-IS-1",
                  },
                },
              },
            }),
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

test("sets an endpoint active worker minimum through the fixed REST boundary", async () => {
  const endpointId = "endpoint_test";
  const signal = {};
  let bodyCancelled = false;
  await setRunpodEndpointWorkersMin(
    { apiKey, endpointId, workersMin: 1 },
    {
      createTimeoutSignal(milliseconds) {
        assert.equal(milliseconds, 60_000);
        return signal;
      },
      async fetchImplementation(url, init) {
        assert.equal(url.href, `https://rest.runpod.io/v1/endpoints/${endpointId}`);
        assert.deepEqual(init, {
          body: JSON.stringify({ workersMin: 1 }),
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

test("validates active worker minimum before sending a mutation", async () => {
  let requests = 0;
  for (const input of [
    { endpointId: "../unsafe", workersMin: 0 },
    { endpointId: "endpoint_test", workersMin: -1 },
    { endpointId: "endpoint_test", workersMin: 1.5 },
    { endpointId: "endpoint_test", workersMin: 101 },
  ]) {
    await assert.rejects(
      setRunpodEndpointWorkersMin(
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

test("classifies active worker update response loss without retrying", async () => {
  let requests = 0;
  await assert.rejects(
    setRunpodEndpointWorkersMin(
      { apiKey, endpointId: "endpoint_test", workersMin: 1 },
      {
        async fetchImplementation() {
          requests += 1;
          throw new Error("provider response containing sensitive data");
        },
      },
    ),
    (error) => {
      assert.equal(error.message, "RunPod endpoint active worker update outcome is unknown");
      return true;
    },
  );
  assert.equal(requests, 1);
});

function graphqlEndpointConfiguration(endpointId, overrides = {}) {
  return {
    compliance: [],
    computeType: "GPU",
    executionTimeoutMs: 21_600_000,
    flashBootType: "OFF",
    gpuCount: 1,
    gpuIds: "ADA_24",
    id: endpointId,
    idleTimeout: 5,
    instanceIds: [],
    minCudaVersion: "12.0",
    modelReferences: [],
    name: "scribe-drop-test",
    networkVolumeId: null,
    networkVolumeIds: [],
    scalerType: "QUEUE_DELAY",
    scalerValue: 4,
    templateId: "template_test",
    workersMax: 0,
    workersMin: 0,
    ...overrides,
  };
}

test("sets exact data centers through a full GraphQL configuration round-trip", async () => {
  const endpointId = "endpoint_test";
  const dataCenterIds = ["EUR-IS-1", "EU-RO-1"];
  const readSignal = {};
  const mutationSignal = {};
  const timeoutSignals = [readSignal, mutationSignal];
  const timeouts = [];
  let requests = 0;
  let observed;
  await setRunpodEndpointDataCenters(
    { apiKey, dataCenterIds, endpointId },
    {
      createTimeoutSignal(milliseconds) {
        timeouts.push(milliseconds);
        return timeoutSignals[timeouts.length - 1];
      },
      async fetchImplementation(url, init) {
        requests += 1;
        if (requests === 1) {
          assert.equal(url.href, "https://api.runpod.io/graphql");
          assert.equal(init.method, "POST");
          assert.equal(init.signal, readSignal);
          const readBody = JSON.parse(init.body);
          assert.equal(readBody.variables.id, endpointId);
          return jsonResponse({
            data: {
              myself: {
                endpoint: graphqlEndpointConfiguration(endpointId),
              },
            },
            errors: [],
          });
        }
        observed = { init, url };
        return jsonResponse({
          data: { saveEndpoint: { id: endpointId, locations: dataCenterIds.join(",") } },
          errors: [],
        });
      },
    },
  );
  assert.equal(observed.url.href, "https://api.runpod.io/graphql");
  assert.equal(observed.init.method, "POST");
  assert.deepEqual(observed.init.headers, {
    Authorization: `Bearer ${apiKey}`,
    "Content-Type": "application/json",
  });
  assert.equal(observed.init.redirect, "error");
  assert.equal(observed.init.signal, mutationSignal);
  assert.deepEqual(timeouts, [15_000, 60_000]);
  assert.equal(requests, 2);
  const body = JSON.parse(observed.init.body);
  assert.equal(body.variables.input.id, endpointId);
  assert.equal(body.variables.input.locations, dataCenterIds.join(","));
  assert.equal(body.variables.input.gpuIds, "ADA_24");
  assert.equal(body.variables.input.templateId, templateId);
  assert.equal(body.variables.input.workersMax, 0);
  assert.deepEqual(body.variables.input.networkVolumeIds, []);
  assert.equal(Object.hasOwn(body.variables.input, "compliance"), false);
});

test("clears data-center restrictions through an explicit GraphQL null", async () => {
  const endpointId = "endpoint_test";
  let observed;
  await setRunpodEndpointDataCenters(
    { apiKey, dataCenterIds: [], endpointId },
    {
      async fetchImplementation(url, init) {
        observed = { init, url };
        return jsonResponse({
          data: { saveEndpoint: { id: endpointId, locations: null } },
          errors: [],
        });
      },
      getEndpointConfiguration() {
        return graphqlEndpointConfiguration(endpointId);
      },
    },
  );
  assert.equal(observed.url.href, "https://api.runpod.io/graphql");
  const body = JSON.parse(observed.init.body);
  assert.equal(body.variables.input.locations, null);
});

test("sets ordered GPU fallbacks without sending a data-center field", async () => {
  const endpointId = "endpoint_test";
  const gpuTypeIds = [
    "NVIDIA GeForce RTX 5090",
    "NVIDIA GeForce RTX 4090",
    "NVIDIA RTX PRO 6000 Blackwell Server Edition",
  ];
  let bodyCancelled = false;
  await setRunpodEndpointGpuTypes(
    { apiKey, endpointId, gpuTypeIds },
    {
      async fetchImplementation(url, init) {
        assert.equal(url.href, `https://rest.runpod.io/v1/endpoints/${endpointId}`);
        assert.equal(init.body, JSON.stringify({ gpuTypeIds }));
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

test("validates endpoint GPU policy before sending a mutation", async () => {
  let requests = 0;
  for (const input of [
    {
      endpointId: "../unsafe",
      gpuTypeIds: ["NVIDIA L4"],
    },
    {
      endpointId: "endpoint_test",
      gpuTypeIds: [],
    },
    {
      endpointId: "endpoint_test",
      gpuTypeIds: ["NVIDIA L4", "NVIDIA L4"],
    },
  ]) {
    await assert.rejects(
      setRunpodEndpointGpuTypes(
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

test("validates data centers and rejects nonempty compliance before mutation", async () => {
  let requests = 0;
  for (const dataCenterIds of [null, ["EU-RO-1", "EU-RO-1"]]) {
    await assert.rejects(
      setRunpodEndpointDataCenters(
        { apiKey, dataCenterIds, endpointId: "endpoint_test" },
        {
          async fetchImplementation() {
            requests += 1;
            return jsonResponse({});
          },
          getEndpointConfiguration() {
            return graphqlEndpointConfiguration("endpoint_test");
          },
        },
      ),
      /missing or invalid/u,
    );
  }
  await assert.rejects(
    setRunpodEndpointDataCenters(
      {
        apiKey,
        dataCenterIds: ["EU-RO-1"],
        endpointId: "endpoint_test",
      },
      {
        async fetchImplementation() {
          requests += 1;
          return jsonResponse({});
        },
        getEndpointConfiguration() {
          return graphqlEndpointConfiguration("endpoint_test", {
            compliance: ["HIPAA"],
          });
        },
      },
    ),
    /compliance filter/u,
  );
  assert.equal(requests, 0);
});

test("classifies data-center response loss without retrying", async () => {
  let requests = 0;
  await assert.rejects(
    setRunpodEndpointDataCenters(
      {
        apiKey,
        dataCenterIds: ["EU-RO-1"],
        endpointId: "endpoint_test",
      },
      {
        async fetchImplementation() {
          requests += 1;
          throw new Error("provider response containing sensitive data");
        },
        getEndpointConfiguration() {
          return graphqlEndpointConfiguration("endpoint_test");
        },
      },
    ),
    (error) => {
      assert.equal(error.message, "RunPod endpoint data-center update outcome is unknown");
      return true;
    },
  );
  assert.equal(requests, 1);
});

test("classifies endpoint GPU response loss without retrying", async () => {
  let requests = 0;
  await assert.rejects(
    setRunpodEndpointGpuTypes(
      {
        apiKey,
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
      assert.equal(error.message, "RunPod endpoint GPU update outcome is unknown");
      return true;
    },
  );
  assert.equal(requests, 1);
});
