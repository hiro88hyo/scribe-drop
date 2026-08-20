import { describe, expect, it } from "vitest";

import { defaultSyntheticAuthorizations } from "./control-store.js";
import {
  createReleaseSupplyChainDeploymentPlan,
  releaseSupplyChainDeploymentPlanSchema,
} from "./release-supply-chain.js";
import type { ControllerServiceDeploymentConfiguration } from "./service-deployment.js";

function deployment(): ControllerServiceDeploymentConfiguration {
  return {
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
  };
}

describe("release candidate supply-chain deployment policy", () => {
  it("fixes one project attestor, global Note, Singapore KMS key, and separate identities", () => {
    const plan = createReleaseSupplyChainDeploymentPlan({
      deployment: deployment(),
      projectNumber: "123456789012",
    });

    expect(plan.apiServices).toEqual([
      "artifactregistry.googleapis.com",
      "binaryauthorization.googleapis.com",
      "cloudkms.googleapis.com",
      "cloudresourcemanager.googleapis.com",
      "containeranalysis.googleapis.com",
      "iamcredentials.googleapis.com",
      "sts.googleapis.com",
    ]);
    expect(plan.attestor.name).toBe(
      "projects/scribe-phase14/attestors/scribe-drop-release-candidate",
    );
    expect(plan.attestor.userOwnedGrafeasNote).toEqual({
      noteReference: "projects/scribe-phase14/notes/scribe-drop-release-candidate",
      publicKeys: [
        {
          id: "//cloudkms.googleapis.com/v1/projects/scribe-phase14/locations/asia-southeast1/keyRings/scribe-drop-release/cryptoKeys/candidate-attestor/cryptoKeyVersions/1",
          pkixPublicKey: { signatureAlgorithm: "ECDSA_P256_SHA256" },
        },
      ],
    });
    expect(plan.kms.signingVersion).toMatchObject({
      algorithm: "EC_SIGN_P256_SHA256",
      protectionLevel: "SOFTWARE",
      state: "ENABLED",
    });
    expect(plan.identities.publisher).not.toBe(plan.identities.signer);
    expect(plan.permissions.cryptoKey.bindings).toEqual([
      {
        members: ["serviceAccount:sd-release-signer@scribe-phase14.iam.gserviceaccount.com"],
        role: "roles/cloudkms.signerVerifier",
      },
    ]);
  });

  it("requires both immutable images and grants publisher access to only their repositories", () => {
    const plan = createReleaseSupplyChainDeploymentPlan({
      deployment: deployment(),
      projectNumber: "123456789012",
    });

    expect(plan.images).toEqual([
      deployment().controllerImageDigest,
      deployment().manifest.imageDigest,
    ]);
    expect(plan.permissions.repositories.map(({ resource }) => resource)).toEqual([
      "projects/scribe-phase14/locations/asia-southeast1/repositories/controller",
      "projects/scribe-phase14/locations/asia-southeast1/repositories/worker",
    ]);
    expect(plan.permissions.repositories.flatMap(({ bindings }) => bindings)).toEqual([
      {
        members: ["serviceAccount:sd-candidate-publisher@scribe-phase14.iam.gserviceaccount.com"],
        role: "roles/artifactregistry.writer",
      },
      {
        members: ["serviceAccount:sd-candidate-publisher@scribe-phase14.iam.gserviceaccount.com"],
        role: "roles/artifactregistry.writer",
      },
    ]);
  });

  it("rejects resource, key, identity, and repository drift", () => {
    const plan = createReleaseSupplyChainDeploymentPlan({
      deployment: deployment(),
      projectNumber: "123456789012",
    });
    const wrongKey = structuredClone(plan);
    wrongKey.kms.signingVersion.name = wrongKey.kms.signingVersion.name.replace(
      "/cryptoKeyVersions/1",
      "/cryptoKeyVersions/2",
    );
    expect(() => releaseSupplyChainDeploymentPlanSchema.parse(wrongKey)).toThrow(
      "release supply-chain resources drifted",
    );

    const sameIdentity = structuredClone(plan);
    sameIdentity.identities.publisher = sameIdentity.identities.signer;
    expect(() => releaseSupplyChainDeploymentPlanSchema.parse(sameIdentity)).toThrow(
      "publisher and signer must be distinct",
    );

    const sameRepository = deployment();
    sameRepository.manifest.imageDigest = sameRepository.controllerImageDigest.replace(
      "/runtime@",
      "/worker@",
    );
    expect(() =>
      createReleaseSupplyChainDeploymentPlan({
        deployment: sameRepository,
        projectNumber: "123456789012",
      }),
    ).toThrow("controller and worker repositories must be distinct");
  });
});
