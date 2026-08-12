import { Buffer } from "node:buffer";

import { describe, expect, it, vi } from "vitest";

import type { AccessTokenProvider } from "./cloud-run-client.js";
import { defaultSyntheticAuthorizations } from "./control-store.js";
import {
  createCandidateAttestationListReadbackRequests,
  createCandidateAttestationValidationReadbackRequests,
  GoogleCandidateAttestationReadbackClient,
} from "./candidate-attestation-readback-client.js";
import {
  createCandidateAttestationPayload,
  verifyCandidateAttestationOccurrenceLists,
  type CandidateAttestationOccurrenceList,
} from "./candidate-attestation-readback.js";
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

function occurrenceList(
  expected: ReturnType<typeof plan>,
  index: 0 | 1,
): CandidateAttestationOccurrenceList {
  const image = expected.images[index];
  return {
    occurrences: [
      {
        attestation: {
          serializedPayload: Buffer.from(createCandidateAttestationPayload(image), "utf8").toString(
            "base64",
          ),
          signatures: [
            {
              publicKeyId: expected.attestor.userOwnedDrydockNote.publicKeys[0].id,
              signature: Buffer.from(`signature-${String(index)}`, "utf8").toString("base64"),
            },
          ],
        },
        createTime: `2026-08-12T00:00:0${String(index)}Z`,
        kind: "ATTESTATION",
        name: `projects/${expected.projectId}/occurrences/candidate-${String(index)}`,
        noteName: expected.artifactAnalysisNote.name,
        resourceUri: image,
        updateTime: `2026-08-12T00:00:0${String(index)}Z`,
      },
    ],
  };
}

describe("release candidate attestation read-back client", () => {
  it("builds two bounded filtered lists and two validation-only POSTs", () => {
    const expected = plan();
    const listRequests = createCandidateAttestationListReadbackRequests(expected);
    expect(listRequests).toHaveLength(2);
    const firstRequest = listRequests[0];
    const secondRequest = listRequests[1];
    if (firstRequest === undefined || secondRequest === undefined) {
      throw new Error("candidate attestation list request is missing");
    }
    for (const { image, request } of [
      { image: expected.images[0], request: firstRequest },
      { image: expected.images[1], request: secondRequest },
    ]) {
      const url = new URL(request.url);
      expect(url.origin).toBe("https://containeranalysis.googleapis.com");
      expect(url.pathname).toBe("/v1/projects/scribe-phase14/occurrences");
      expect(url.searchParams.get("pageSize")).toBe("2");
      expect(url.searchParams.get("filter")).toContain(`resourceUrl="${image}"`);
    }
    const occurrences = verifyCandidateAttestationOccurrenceLists(expected, [
      occurrenceList(expected, 0),
      occurrenceList(expected, 1),
    ]);
    const validationRequests = createCandidateAttestationValidationReadbackRequests(
      expected,
      occurrences,
    );
    expect(validationRequests).toHaveLength(2);
    expect(validationRequests.every(({ method }) => method === "POST_VALIDATE_ATTESTATION")).toBe(
      true,
    );
    expect(
      validationRequests.every(({ url }) => url.endsWith(":validateAttestationOccurrence")),
    ).toBe(true);
  });

  it("returns metadata-only evidence after stable list, validation, and final list", async () => {
    const expected = plan();
    const getAccessToken = vi.fn(() => Promise.resolve("candidate-attestation-read-token"));
    const tokens: AccessTokenProvider = {
      getAccessToken,
    };
    const controlPlaneFetch = vi.fn<typeof fetch>((input, init) => {
      const requestUrl =
        typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      const url = new URL(requestUrl);
      const response =
        url.origin === "https://binaryauthorization.googleapis.com"
          ? { result: "VERIFIED" }
          : url.searchParams.get("filter")?.includes(expected.images[0]) === true
            ? occurrenceList(expected, 0)
            : occurrenceList(expected, 1);
      expect(init?.method).toBe(
        url.origin === "https://binaryauthorization.googleapis.com" ? "POST" : "GET",
      );
      return Promise.resolve(
        new Response(JSON.stringify(response), {
          headers: { "Content-Type": "application/json" },
          status: 200,
        }),
      );
    });

    const evidence = await new GoogleCandidateAttestationReadbackClient(
      tokens,
      controlPlaneFetch,
    ).readAndVerify(expected);

    expect(evidence.attestations.map(({ validationResult }) => validationResult)).toEqual([
      "VERIFIED",
      "VERIFIED",
    ]);
    expect(JSON.stringify(evidence)).not.toContain("signature-");
    expect(controlPlaneFetch).toHaveBeenCalledTimes(12);
    expect(getAccessToken).toHaveBeenCalledTimes(3);
  });
});
