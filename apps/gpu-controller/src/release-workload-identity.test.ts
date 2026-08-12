import { describe, expect, it } from "vitest";

import { defaultSyntheticAuthorizations } from "./control-store.js";
import {
  createReleaseWorkloadIdentityPlan,
  releaseWorkloadIdentityPlanSchema,
} from "./release-workload-identity.js";
import { createReleaseSupplyChainDeploymentPlan } from "./release-supply-chain.js";

function supplyChain(): ReturnType<typeof createReleaseSupplyChainDeploymentPlan> {
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

describe("release workload identity policy", () => {
  it("fixes the immutable repository, release workflow, canonical audience, and two identities", () => {
    const plan = createReleaseWorkloadIdentityPlan(supplyChain());

    expect(plan.pool.name).toBe(
      "projects/123456789012/locations/global/workloadIdentityPools/scribe-drop-release",
    );
    expect(plan.provider.oidc).toEqual({
      allowedAudiences: [],
      issuerUri: "https://token.actions.githubusercontent.com",
    });
    expect(plan.provider.attributeCondition).toContain("assertion.repository_id == '1312444559'");
    expect(plan.provider.attributeCondition).toContain(
      "assertion.repository_owner_id == '1670222'",
    );
    expect(plan.provider.attributeCondition).toContain(
      "assertion.event_name == 'workflow_dispatch'",
    );
    expect(plan.provider.attributeCondition).toContain(
      "publish-cloud-run-candidate.yml@refs/heads/release/",
    );
    expect(plan.serviceAccounts.map(({ email }) => email)).toEqual([
      "sd-candidate-publisher@scribe-phase14.iam.gserviceaccount.com",
      "sd-release-signer@scribe-phase14.iam.gserviceaccount.com",
    ]);
    expect(plan.permissions.publisher.bindings).toEqual(plan.permissions.signer.bindings);
    expect(plan.permissions.publisher.bindings[0].members).toEqual([plan.principalSet]);
  });

  it("rejects a renamed provider, broadened principal, or shared identity", () => {
    const plan = createReleaseWorkloadIdentityPlan(supplyChain());
    const wrongProvider = structuredClone(plan);
    wrongProvider.provider.name = wrongProvider.provider.name.replace(
      "/providers/github-actions",
      "/providers/other",
    );
    expect(() => releaseWorkloadIdentityPlanSchema.parse(wrongProvider)).toThrow(
      "release workload identity resources drifted",
    );

    const broadCondition = structuredClone(plan);
    broadCondition.provider.attributeCondition = "assertion.repository_owner_id != ''";
    expect(() => releaseWorkloadIdentityPlanSchema.parse(broadCondition)).toThrow();

    const broadPrincipal = structuredClone(plan);
    broadPrincipal.principalSet = broadPrincipal.principalSet.replace(
      "/attribute.repository_id/1312444559",
      "/*",
    );
    expect(() => releaseWorkloadIdentityPlanSchema.parse(broadPrincipal)).toThrow(
      "release workload identity resources drifted",
    );

    const shared = structuredClone(plan);
    shared.serviceAccounts[1].email = shared.serviceAccounts[0].email;
    expect(() => releaseWorkloadIdentityPlanSchema.parse(shared)).toThrow(
      "release workload identity resources drifted",
    );

    const extraPrincipal = structuredClone(plan) as unknown as {
      permissions: { publisher: { bindings: [{ members: string[] }] } };
    };
    extraPrincipal.permissions.publisher.bindings[0].members.push(
      "principal://iam.googleapis.com/projects/123456789012/locations/global/workloadIdentityPools/other/subject/untrusted",
    );
    expect(() => releaseWorkloadIdentityPlanSchema.parse(extraPrincipal)).toThrow();
  });
});
