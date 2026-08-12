import { describe, expect, it } from "vitest";

import { defaultSyntheticAuthorizations } from "./control-store.js";
import { createReleaseSupplyChainReadbackRequests } from "./release-supply-chain-readback-client.js";
import { createReleaseSupplyChainDeploymentPlan } from "./release-supply-chain.js";

function plan(): ReturnType<typeof createReleaseSupplyChainDeploymentPlan> {
  return createReleaseSupplyChainDeploymentPlan({
    deployment: {
      authorization: defaultSyntheticAuthorizations().staging,
      controllerImageDigest: `asia-southeast1-docker.pkg.dev/scribe-phase14/controller/runtime@sha256:${"b".repeat(64)}`,
      controllerServiceAccount: "gpu-controller@scribe-phase14.iam.gserviceaccount.com",
      firestore: { databaseId: "scribe-staging-controller", projectId: "scribe-phase14" },
      manifest: {
        environment: "staging",
        imageDigest: `asia-southeast1-docker.pkg.dev/scribe-phase14/worker/runtime@sha256:${"a".repeat(64)}`,
        orchestratorOrigin: "https://orchestrator.example.test/",
        projectId: "scribe-phase14",
        resultHost: "storage.example.test",
        runtimeServiceAccount: "gpu-runtime@scribe-phase14.iam.gserviceaccount.com",
        sourceHost: "storage.example.test",
      },
      primaryHmacSecret: { name: "scribe-drop-staging-controller-primary", version: "7" },
      serviceName: "scribe-drop-staging-gpu-controller",
    },
    projectNumber: "123456789012",
  });
}

describe("release supply-chain read-back request plan", () => {
  it("uses only fixed resource GETs and one project getIamPolicy request", () => {
    const requests = createReleaseSupplyChainReadbackRequests(plan());

    expect(requests).toHaveLength(11);
    expect(new Set(requests.map(({ key }) => key)).size).toBe(requests.length);
    expect(requests.filter(({ method }) => method === "POST_GET_IAM_POLICY")).toEqual([
      {
        body: { options: { requestedPolicyVersion: 3 } },
        key: "projectIamPolicy",
        method: "POST_GET_IAM_POLICY",
        url: "https://cloudresourcemanager.googleapis.com/v1/projects/scribe-phase14:getIamPolicy",
      },
    ]);
    expect(requests.map(({ url }) => new URL(url).origin).sort()).toEqual(
      [
        "https://artifactregistry.googleapis.com",
        "https://artifactregistry.googleapis.com",
        "https://binaryauthorization.googleapis.com",
        "https://binaryauthorization.googleapis.com",
        "https://cloudkms.googleapis.com",
        "https://cloudkms.googleapis.com",
        "https://cloudkms.googleapis.com",
        "https://cloudkms.googleapis.com",
        "https://cloudresourcemanager.googleapis.com",
        "https://containeranalysis.googleapis.com",
        "https://containeranalysis.googleapis.com",
      ].sort(),
    );
    expect(requests.every(({ url }) => !url.includes(":setIamPolicy"))).toBe(true);
    expect(requests.every(({ url }) => !url.includes("/occurrences"))).toBe(true);
  });
});
