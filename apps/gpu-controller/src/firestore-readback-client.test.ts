import { describe, expect, it } from "vitest";

import type { AccessTokenProvider } from "./cloud-run-client.js";
import {
  createControllerFirestoreDeploymentPlan,
  type ControllerFirestoreDeploymentPlan,
  type ControllerFirestoreRawReadback,
} from "./firestore-deployment.js";
import { GoogleControllerFirestoreReadbackClient } from "./firestore-readback-client.js";
import { defaultSyntheticAuthorizations } from "./control-store.js";
import type { ControllerServiceDeploymentConfiguration } from "./service-deployment.js";

const configuration: ControllerServiceDeploymentConfiguration = {
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

const tokens: AccessTokenProvider = {
  getAccessToken(): Promise<string> {
    return Promise.resolve("bounded-firestore-readback-token");
  },
};

function requestUrl(input: string | URL | Request): string {
  if (typeof input === "string") return input;
  return input instanceof URL ? input.href : input.url;
}

function rawFirestoreReadback(
  plan: ControllerFirestoreDeploymentPlan,
): ControllerFirestoreRawReadback {
  const ancestorField = `${plan.database.name}/collectionGroups/__default__/fields/*`;
  const ttlFields: ControllerFirestoreRawReadback["ttlFields"] = [
    {
      indexConfig: { ancestorField, reverting: false, usesAncestorConfig: true },
      name: plan.ttlFields[0].name,
      ttlConfig: { expirationOffset: plan.ttlFields[0].expirationOffset, state: "ACTIVE" },
    },
    {
      indexConfig: { ancestorField, reverting: false, usesAncestorConfig: true },
      name: plan.ttlFields[1].name,
      ttlConfig: { expirationOffset: plan.ttlFields[1].expirationOffset, state: "ACTIVE" },
    },
  ];
  return {
    database: {
      ...plan.database,
      createTime: "2026-08-11T00:00:00.000Z",
      earliestVersionTime: "2026-08-11T12:00:00.000Z",
      etag: "firestore-database-etag",
      freeTier: false,
      keyPrefix: "",
      uid: "71c68f3d-c626-4f6a-a4e7-b02d89d5a699",
      updateTime: "2026-08-11T00:01:00.000Z",
      versionRetentionPeriod: plan.environment === "production" ? "604800s" : "3600s",
    },
    ttlFields,
    ttlPolicies: { fields: [...ttlFields] },
  };
}

describe("Google controller Firestore read-back client", () => {
  it("uses fixed GET endpoints and ignores only volatile earliest-version time", async () => {
    const plan = createControllerFirestoreDeploymentPlan(configuration);
    const raw = rawFirestoreReadback(plan);
    let databaseReads = 0;
    let ttlListReads = 0;
    const calls: { readonly init: RequestInit | undefined; readonly url: string }[] = [];
    const fakeFetch: typeof fetch = (input, init) => {
      const url = requestUrl(input);
      calls.push({ init, url });
      if (url.endsWith(`/v1/${plan.database.name}`)) {
        const database = {
          ...raw.database,
          earliestVersionTime:
            databaseReads++ === 0 ? "2026-08-11T12:00:00.000Z" : "2026-08-11T12:00:01.000Z",
        };
        return Promise.resolve(Response.json(database));
      }
      if (url.includes("/collectionGroups/-/fields?")) {
        const fields =
          ttlListReads++ === 0 ? raw.ttlPolicies.fields : [...raw.ttlPolicies.fields].reverse();
        return Promise.resolve(Response.json({ fields }));
      }
      const field = raw.ttlFields.find(({ name }) => url.endsWith(`/v1/${name}`));
      return Promise.resolve(
        field === undefined ? new Response("{}", { status: 404 }) : Response.json(field),
      );
    };

    const evidence = await new GoogleControllerFirestoreReadbackClient(
      tokens,
      fakeFetch,
    ).readAndVerify(plan);

    expect(evidence.databaseEtag).toBe("firestore-database-etag");
    expect(calls).toHaveLength(8);
    expect(new Set(calls.map(({ url }) => url))).toEqual(
      new Set([
        `https://firestore.googleapis.com/v1/${plan.database.name}`,
        `https://firestore.googleapis.com/v1/${plan.database.name}/collectionGroups/-/fields?filter=ttlConfig%3A*&pageSize=3`,
        ...plan.ttlFields.map(({ name }) => `https://firestore.googleapis.com/v1/${name}`),
      ]),
    );
    for (const call of calls) {
      expect(call.init?.method).toBe("GET");
      expect(call.init?.body).toBeUndefined();
      expect(new Headers(call.init?.headers).get("authorization")).toBe(
        "Bearer bounded-firestore-readback-token",
      );
    }
  });

  it("rejects stable non-active TTL and meaningful database drift", async () => {
    const plan = createControllerFirestoreDeploymentPlan(configuration);
    const nonActive = rawFirestoreReadback(plan);
    nonActive.ttlFields[0].ttlConfig.state = "CREATING";
    const stableFetch: typeof fetch = (input) => {
      const url = requestUrl(input);
      if (url.endsWith(`/v1/${plan.database.name}`)) {
        return Promise.resolve(Response.json(nonActive.database));
      }
      if (url.includes("/collectionGroups/-/fields?")) {
        return Promise.resolve(Response.json(nonActive.ttlPolicies));
      }
      const field = nonActive.ttlFields.find(({ name }) => url.endsWith(`/v1/${name}`));
      return Promise.resolve(Response.json(field));
    };
    await expect(
      new GoogleControllerFirestoreReadbackClient(tokens, stableFetch).readAndVerify(plan),
    ).rejects.toThrow("Firestore TTL policy read-back does not match the deployment plan");

    let databaseReads = 0;
    const driftingFetch: typeof fetch = (input) => {
      const url = requestUrl(input);
      if (url.endsWith(`/v1/${plan.database.name}`)) {
        return Promise.resolve(
          Response.json({
            ...nonActive.database,
            locationId: databaseReads++ === 0 ? "asia-southeast1" : "us-central1",
          }),
        );
      }
      if (url.includes("/collectionGroups/-/fields?")) {
        return Promise.resolve(Response.json(rawFirestoreReadback(plan).ttlPolicies));
      }
      const field = rawFirestoreReadback(plan).ttlFields.find(({ name }) =>
        url.endsWith(`/v1/${name}`),
      );
      return Promise.resolve(Response.json(field));
    };
    await expect(
      new GoogleControllerFirestoreReadbackClient(tokens, driftingFetch).readAndVerify(plan),
    ).rejects.toThrow("control-plane resources changed during read-back");
  });
});
