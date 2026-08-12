import { describe, expect, it } from "vitest";

import { defaultSyntheticAuthorizations } from "./control-store.js";
import {
  verifyReleaseSupplyChainReadback,
  type ReleaseSupplyChainRawReadback,
} from "./release-supply-chain-readback.js";
import { createReleaseSupplyChainDeploymentPlan } from "./release-supply-chain.js";
import type { ControllerServiceDeploymentConfiguration } from "./service-deployment.js";

const PUBLIC_KEY_PEM = `-----BEGIN PUBLIC KEY-----\n${"A".repeat(128)}\n-----END PUBLIC KEY-----\n`;

function crc32c(value: string): string {
  let checksum = 0xffffffff;
  for (const byte of new TextEncoder().encode(value)) {
    checksum ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      checksum = (checksum >>> 1) ^ (checksum & 1 ? 0x82f63b78 : 0);
    }
  }
  return String((checksum ^ 0xffffffff) >>> 0);
}

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

function fixture(): {
  readonly plan: ReturnType<typeof createReleaseSupplyChainDeploymentPlan>;
  readonly raw: ReleaseSupplyChainRawReadback;
} {
  const plan = createReleaseSupplyChainDeploymentPlan({
    deployment: deployment(),
    projectNumber: "123456789012",
  });
  const publicKey = plan.attestor.userOwnedDrydockNote.publicKeys[0];
  const version = plan.kms.signingVersion;
  return {
    plan,
    raw: {
      attestor: {
        description: plan.attestor.description,
        etag: "attestor-etag",
        name: plan.attestor.name,
        updateTime: "2026-08-12T00:00:00Z",
        userOwnedDrydockNote: {
          delegationServiceAccountEmail: plan.identities.binaryAuthorizationServiceAgent,
          noteReference: plan.attestor.userOwnedDrydockNote.noteReference,
          publicKeys: [
            {
              id: publicKey.id,
              pkixPublicKey: {
                publicKeyPem: PUBLIC_KEY_PEM,
                signatureAlgorithm: publicKey.pkixPublicKey.signatureAlgorithm,
              },
            },
          ],
        },
      },
      attestorIamPolicy: {
        bindings: plan.permissions.attestor.bindings,
        etag: "attestor-iam-etag",
        version: 1,
      },
      cryptoKey: {
        ...plan.kms.cryptoKey,
        createTime: "2026-08-12T00:00:00Z",
      },
      cryptoKeyIamPolicy: {
        bindings: plan.permissions.cryptoKey.bindings,
        etag: "key-iam-etag",
        version: 1,
      },
      cryptoKeyVersions: {
        cryptoKeyVersions: [
          {
            ...version,
            createTime: "2026-08-12T00:00:01Z",
            generateTime: "2026-08-12T00:00:02Z",
            reimportEligible: false,
          },
        ],
        totalSize: 1,
      },
      kmsPublicKey: {
        algorithm: version.algorithm,
        name: version.name,
        pem: PUBLIC_KEY_PEM,
        pemCrc32c: crc32c(PUBLIC_KEY_PEM),
        protectionLevel: version.protectionLevel,
        publicKeyFormat: "PEM",
      },
      note: {
        ...plan.artifactAnalysisNote,
        createTime: "2026-08-12T00:00:00Z",
        kind: "ATTESTATION",
        relatedNoteNames: [],
        relatedUrl: [],
        updateTime: "2026-08-12T00:00:01Z",
      },
      noteIamPolicy: {
        bindings: plan.permissions.note.bindings,
        etag: "note-iam-etag",
        version: 1,
      },
      projectIamPolicy: {
        bindings: [
          { members: ["user:maintainer@example.test"], role: "roles/viewer" },
          ...plan.permissions.project.bindings,
        ],
        etag: "project-iam-etag",
        version: 1,
      },
      repositories: plan.permissions.repositories.map((repository) => ({
        iamPolicy: {
          bindings: [
            ...repository.bindings,
            {
              members: ["serviceAccount:gpu-controller@scribe-phase14.iam.gserviceaccount.com"],
              role: "roles/artifactregistry.reader",
            },
          ],
          etag: `${repository.resource}-etag`,
          version: 1 as const,
        },
        resource: repository.resource,
      })) as ReleaseSupplyChainRawReadback["repositories"],
    },
  };
}

describe("release candidate supply-chain read-back", () => {
  it("accepts one exact attestor, Note, KMS key version, public key, and least IAM", () => {
    const { plan, raw } = fixture();

    expect(verifyReleaseSupplyChainReadback(plan, raw)).toMatchObject({
      attestorEtag: "attestor-etag",
      cryptoKeyCreateTime: "2026-08-12T00:00:00Z",
      keyVersionGenerateTime: "2026-08-12T00:00:02Z",
      noteCreateTime: "2026-08-12T00:00:00Z",
      projectIam: { etag: "project-iam-etag", version: 1 },
    });
  });

  it("rejects an attestor public key that differs from the KMS response", () => {
    const { plan, raw } = fixture();
    raw.attestor.userOwnedDrydockNote.publicKeys[0].pkixPublicKey.publicKeyPem =
      PUBLIC_KEY_PEM.replace("AAAA", "BBBB");

    expect(() => verifyReleaseSupplyChainReadback(plan, raw)).toThrow(
      "attestor public key does not match the KMS signing version",
    );
  });

  it("rejects a second key version or signer permission drift", () => {
    const extraVersion = fixture();
    extraVersion.raw.cryptoKeyVersions.cryptoKeyVersions.push({
      ...extraVersion.raw.cryptoKeyVersions.cryptoKeyVersions[0],
      name: extraVersion.raw.cryptoKeyVersions.cryptoKeyVersions[0].name.replace(
        "/cryptoKeyVersions/1",
        "/cryptoKeyVersions/2",
      ),
    });
    expect(() => verifyReleaseSupplyChainReadback(extraVersion.plan, extraVersion.raw)).toThrow();

    const wrongSigner = fixture();
    wrongSigner.raw.projectIamPolicy.bindings = [
      {
        members: [`serviceAccount:${wrongSigner.plan.identities.signer}`],
        role: "roles/editor",
      },
    ];
    expect(() => verifyReleaseSupplyChainReadback(wrongSigner.plan, wrongSigner.raw)).toThrow(
      "controller principal IAM bindings exceed the expected policy",
    );
  });

  it("rejects duplicate repository observations", () => {
    const { plan, raw } = fixture();
    raw.repositories[1] = structuredClone(raw.repositories[0]);

    expect(() => verifyReleaseSupplyChainReadback(plan, raw)).toThrow(
      "candidate repository read-back contains duplicates",
    );
  });
});
