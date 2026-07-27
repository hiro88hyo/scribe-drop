import assert from "node:assert/strict";
import { test } from "node:test";

import { clearRunpodTemplatePorts } from "./runpod-template-api.mjs";

const apiKey = "dummy_runpod_api_key_for_tests";
const templateId = "template_test";

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
