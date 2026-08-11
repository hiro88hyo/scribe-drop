import assert from "node:assert/strict";
import { test } from "node:test";

import { verifyGpuControllerImageInspection } from "./gpu-controller-image.mjs";

function inspection() {
  return [
    {
      Architecture: "amd64",
      Config: {
        Entrypoint: ["/nodejs/bin/node", "dist/entrypoint.js"],
        Env: [
          "PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
          "HOME=/nonexistent",
          "NODE_ENV=production",
          "PORT=8080",
        ],
        ExposedPorts: { "8080/tcp": {} },
        Labels: {
          "io.scribedrop.controller.policy": "cloud_run_jobs_l4_v1",
          "io.scribedrop.node.version": "24.18.0",
          "org.opencontainers.image.base.digest":
            "sha256:b1386d556b478c420927eb212236bfb31be9834a4549850a060a6351f7fff514",
          "org.opencontainers.image.base.name": "gcr.io/distroless/nodejs24-debian13:nonroot",
          "org.opencontainers.image.title": "ScribeDrop GPU Controller",
        },
        User: "10001:10001",
        Volumes: null,
        WorkingDir: "/app",
      },
      Os: "linux",
      Size: 150_000_000,
    },
  ];
}

test("accepts the exact non-root controller image inspection", () => {
  assert.doesNotThrow(() => verifyGpuControllerImageInspection(inspection()));
});

test("rejects credential, entrypoint, platform, and volume drift", () => {
  const cases = [
    { Config: { Env: ["SCRIBE_DROP_CONTROLLER_HMAC_PRIMARY=secret"] } },
    { Config: { Entrypoint: ["sh"] } },
    { Architecture: "arm64" },
    { Config: { Volumes: { "/data": {} } } },
  ];
  for (const drift of cases) {
    const candidate = inspection();
    const image = candidate[0];
    assert.ok(image);
    Object.assign(image, drift);
    if (drift.Config !== undefined) Object.assign(image.Config, drift.Config);
    assert.throws(() => verifyGpuControllerImageInspection(candidate));
  }
});
