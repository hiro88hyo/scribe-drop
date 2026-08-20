import assert from "node:assert/strict";
import test from "node:test";

import { selectProductionControllerOrigin } from "./export-cloud-run-controller-origin.mjs";

const serviceName =
  "projects/scribe-drop/locations/asia-southeast1/services/scribe-drop-production-gpu-controller";
const expectedOrigin =
  "https://scribe-drop-production-gpu-controller-601035271372.asia-southeast1.run.app";

test("selects the exact project-number origin when Cloud Run reports a hash main URI", () => {
  assert.equal(
    selectProductionControllerOrigin({
      name: serviceName,
      uri: "https://scribe-drop-production-gpu-controller-jxx35hxdaq-as.a.run.app",
      urls: [
        expectedOrigin,
        "https://scribe-drop-production-gpu-controller-jxx35hxdaq-as.a.run.app",
      ],
    }),
    expectedOrigin,
  );
});

test("rejects a response for another Cloud Run Service", () => {
  assert.throws(
    () =>
      selectProductionControllerOrigin({
        name: "projects/scribe-drop/locations/asia-southeast1/services/other",
        urls: [expectedOrigin],
      }),
    /Production controller origin is invalid/u,
  );
});

test("rejects a response that omits the exact project-number origin", () => {
  assert.throws(
    () =>
      selectProductionControllerOrigin({
        name: serviceName,
        urls: ["https://scribe-drop-production-gpu-controller-jxx35hxdaq-as.a.run.app"],
      }),
    /Production controller origin is invalid/u,
  );
});
