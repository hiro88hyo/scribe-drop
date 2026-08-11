import { describe, expect, it } from "vitest";

import type { AccessTokenProvider } from "./cloud-run-client.js";
import { defaultSyntheticAuthorizations } from "./control-store.js";
import { createControllerIamDeploymentPlan } from "./iam-deployment.js";
import { GoogleControllerIamReadbackClient } from "./iam-readback-client.js";
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

function requestUrl(input: string | URL | Request): string {
  if (typeof input === "string") return input;
  return input instanceof URL ? input.href : input.url;
}

const tokens: AccessTokenProvider = {
  getAccessToken(): Promise<string> {
    return Promise.resolve("bounded-iam-readback-token");
  },
};

describe("Google controller IAM read-back client", () => {
  it("uses only fixed role and getIamPolicy reads in two stable snapshots", async () => {
    const plan = createControllerIamDeploymentPlan(configuration);
    const fixtures = new Map<string, unknown>([
      [
        `https://iam.googleapis.com/v1/${plan.cloudRunRole.name}`,
        { ...plan.cloudRunRole, etag: "cloud-run-role-etag" },
      ],
      [
        `https://iam.googleapis.com/v1/${plan.firestoreRole.name}`,
        { ...plan.firestoreRole, etag: "firestore-role-etag" },
      ],
      [
        `https://cloudresourcemanager.googleapis.com/v1/${plan.projectResource}:getIamPolicy`,
        { bindings: plan.projectBindings, etag: "project-iam-etag", version: 3 },
      ],
      [
        `https://artifactregistry.googleapis.com/v1/${plan.artifactRepository.resource}:getIamPolicy?options.requestedPolicyVersion=3`,
        {
          bindings: plan.artifactRepository.bindings,
          etag: "repository-iam-etag",
          version: 1,
        },
      ],
      [
        `https://iam.googleapis.com/v1/${plan.runtimeServiceAccount.resource}:getIamPolicy?options.requestedPolicyVersion=3`,
        {
          bindings: plan.runtimeServiceAccount.bindings,
          etag: "runtime-iam-etag",
          version: 1,
        },
      ],
    ]);
    const calls: { readonly init: RequestInit | undefined; readonly url: string }[] = [];
    const fakeFetch: typeof fetch = (input, init) => {
      const url = requestUrl(input);
      calls.push({ init, url });
      const fixture = fixtures.get(url);
      return Promise.resolve(
        fixture === undefined
          ? new Response("{}", { status: 404 })
          : Response.json(fixture, { status: 200 }),
      );
    };
    const client = new GoogleControllerIamReadbackClient(tokens, fakeFetch);

    const evidence = await client.readAndVerify(plan);

    expect(evidence.project.etag).toBe("project-iam-etag");
    expect(calls).toHaveLength(fixtures.size * 2);
    expect(new Set(calls.map(({ url }) => url))).toEqual(new Set(fixtures.keys()));
    for (const call of calls) {
      expect(call.url).not.toContain("setIamPolicy");
      expect(new Headers(call.init?.headers).get("authorization")).toBe(
        "Bearer bounded-iam-readback-token",
      );
      expect(new Headers(call.init?.headers).get("x-goog-user-project")).toBe("scribe-phase14");
      if (call.url.includes("cloudresourcemanager.googleapis.com")) {
        expect(call.init?.method).toBe("POST");
        expect(call.init?.body).toBe('{"options":{"requestedPolicyVersion":3}}');
      } else if (call.url.includes("serviceAccounts")) {
        expect(call.init?.method).toBe("POST");
        expect(call.init?.body).toBeUndefined();
      } else {
        expect(call.init?.method).toBe("GET");
        expect(call.init?.body).toBeUndefined();
      }
    }
  });

  it("rejects a stable custom-role permission expansion", async () => {
    const plan = createControllerIamDeploymentPlan(configuration);
    const expandedRole = {
      ...plan.cloudRunRole,
      etag: "expanded-role-etag",
      includedPermissions: [...plan.cloudRunRole.includedPermissions, "run.jobs.update"],
    };
    const fakeFetch: typeof fetch = (input) => {
      const url = requestUrl(input);
      if (url.endsWith(`/v1/${plan.cloudRunRole.name}`)) {
        return Promise.resolve(Response.json(expandedRole));
      }
      if (url.endsWith(`/v1/${plan.firestoreRole.name}`)) {
        return Promise.resolve(
          Response.json({ ...plan.firestoreRole, etag: "firestore-role-etag" }),
        );
      }
      if (url.includes("cloudresourcemanager.googleapis.com")) {
        return Promise.resolve(
          Response.json({ bindings: plan.projectBindings, etag: "project-etag", version: 3 }),
        );
      }
      if (url.includes("artifactregistry.googleapis.com")) {
        return Promise.resolve(
          Response.json({
            bindings: plan.artifactRepository.bindings,
            etag: "repository-etag",
            version: 1,
          }),
        );
      }
      return Promise.resolve(
        Response.json({
          bindings: plan.runtimeServiceAccount.bindings,
          etag: "runtime-etag",
          version: 1,
        }),
      );
    };

    await expect(
      new GoogleControllerIamReadbackClient(tokens, fakeFetch).readAndVerify(plan),
    ).rejects.toThrow("custom IAM role read-back does not match the permission manifest");
  });
});
