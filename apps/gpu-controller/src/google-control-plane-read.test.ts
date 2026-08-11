import { describe, expect, it, vi } from "vitest";

import type { AccessTokenProvider } from "./cloud-run-client.js";
import { BoundedGoogleControlPlaneReadClient } from "./google-control-plane-read.js";

const tokens: AccessTokenProvider = {
  getAccessToken(): Promise<string> {
    return Promise.resolve("bounded-control-plane-read-token");
  },
};

describe("bounded Google control-plane reads", () => {
  it("rejects non-Google origins and mutation methods before fetch", async () => {
    const controlPlaneFetch = vi.fn<typeof fetch>();
    const client = new BoundedGoogleControlPlaneReadClient(tokens, controlPlaneFetch);

    await expect(
      client.stableSnapshot("scribe-phase14", [
        { key: "outside", method: "GET", url: "https://example.test/v1/resource" },
      ]),
    ).rejects.toThrow("control-plane read-back endpoint is not allowed");
    await expect(
      client.stableSnapshot("scribe-phase14", [
        {
          key: "mutation",
          method: "POST_GET_IAM_POLICY",
          url: "https://iam.googleapis.com/v1/projects/scribe-phase14:setIamPolicy",
        },
      ]),
    ).rejects.toThrow("control-plane read-back endpoint is not allowed");
    expect(controlPlaneFetch).not.toHaveBeenCalled();
  });

  it("rejects invalid quota projects, duplicate keys, and malformed policy bodies", async () => {
    const controlPlaneFetch = vi.fn<typeof fetch>();
    const client = new BoundedGoogleControlPlaneReadClient(tokens, controlPlaneFetch);
    const request = {
      key: "policy",
      method: "GET" as const,
      url: "https://iam.googleapis.com/v1/projects/scribe-phase14/roles/controller",
    };

    await expect(client.stableSnapshot("../other", [request])).rejects.toThrow();
    await expect(client.stableSnapshot("scribe-phase14", [request, request])).rejects.toThrow(
      "control-plane read-back request set is invalid",
    );
    await expect(
      client.stableSnapshot("scribe-phase14", [
        {
          body: { options: { requestedPolicyVersion: 1 } },
          key: "policy",
          method: "POST_GET_IAM_POLICY",
          url: "https://cloudresourcemanager.googleapis.com/v1/projects/scribe-phase14:getIamPolicy",
        } as never,
      ]),
    ).rejects.toThrow();
    expect(controlPlaneFetch).not.toHaveBeenCalled();
  });
});
