import { describe, expect, it } from "vitest";

import { CloudRunJobsClient } from "./cloud-run-client.js";
import { createFixedJobManifest, type ProviderJob } from "./provider.js";

const MANIFEST = createFixedJobManifest(
  {
    environment: "staging",
    projectId: "scribe-phase12",
    imageDigest: `asia-southeast1-docker.pkg.dev/scribe-phase12/worker/runtime@sha256:${"a".repeat(64)}`,
    runtimeServiceAccount: "runtime@scribe-phase12.iam.gserviceaccount.com",
    orchestratorOrigin: "https://orchestrator.example.test",
    resultHost: "storage.example.test",
    sourceHost: "storage.example.test",
  },
  "h".repeat(43),
  "01K28000000000000000000000",
);
const JOB: ProviderJob = {
  ref: "projects/scribe-phase12/locations/asia-southeast1/jobs/sd-stg-job",
  uid: "11111111-1111-4111-8111-111111111111",
  etag: "job-etag",
  ready: true,
  manifest: MANIFEST,
};

function requestUrl(input: RequestInfo | URL): string {
  if (typeof input === "string") return input;
  return input instanceof URL ? input.href : input.url;
}

function requestBody(body: BodyInit | null | undefined): string {
  if (typeof body !== "string") throw new Error("expected a JSON string body");
  return body;
}

describe("Cloud Run Jobs REST adapter", () => {
  it("sends only a fixed create manifest and an etag-only run body", async () => {
    const calls: { readonly url: string; readonly init: RequestInit }[] = [];
    const providerFetch: typeof fetch = (input, init = {}) => {
      calls.push({ url: requestUrl(input), init });
      return Promise.resolve(
        Response.json({
          name: `projects/scribe-phase12/locations/asia-southeast1/operations/${String(calls.length)}`,
        }),
      );
    };
    const client = new CloudRunJobsClient(
      { projectId: "scribe-phase12", region: "asia-southeast1" },
      { getAccessToken: () => Promise.resolve("test-token-not-logged") },
      providerFetch,
    );

    await client.createJob("sd-stg-job", MANIFEST);
    await client.runJob(JOB);

    expect(calls[0]?.url).toBe(
      "https://run.googleapis.com/v2/projects/scribe-phase12/locations/asia-southeast1/jobs?jobId=sd-stg-job",
    );
    expect(JSON.parse(requestBody(calls[0]?.init.body))).toEqual(MANIFEST);
    expect(MANIFEST.template.template.containers[0].env[4].value).toBe(
      "https://orchestrator.example.test/",
    );
    expect(MANIFEST.template.template.containers[0].env[5].value).toBe(
      "https://orchestrator.example.test/internal/cloud-run/bootstrap",
    );
    expect(calls[1]?.url).toBe(
      "https://run.googleapis.com/v2/projects/scribe-phase12/locations/asia-southeast1/jobs/sd-stg-job:run",
    );
    expect(JSON.parse(requestBody(calls[1]?.init.body))).toEqual({ etag: "job-etag" });
    expect(requestBody(calls[1]?.init.body)).not.toContain("overrides");
    expect(calls.every((call) => call.init.redirect === "manual")).toBe(true);
  });

  it("bounds execution listing and treats redirects or malformed provider bodies as unavailable", async () => {
    const responses = [
      Response.json({ executions: [{ invalid: true }] }),
      new Response("", { status: 302, headers: { Location: "https://example.invalid" } }),
    ];
    const providerFetch: typeof fetch = () => {
      const response = responses.shift();
      if (response === undefined) throw new Error("unexpected request");
      return Promise.resolve(response);
    };
    const client = new CloudRunJobsClient(
      { projectId: "scribe-phase12", region: "asia-southeast1" },
      { getAccessToken: () => Promise.resolve("token") },
      providerFetch,
    );

    expect(await client.listExecutions("sd-stg-job")).toEqual({ outcome: "unavailable" });
    expect(await client.getJob("sd-stg-job")).toEqual({ outcome: "unavailable" });
  });

  it("rejects a Job whose Binary Authorization protection is missing or weakened", async () => {
    const validResponse = {
      ...MANIFEST,
      name: JOB.ref,
      uid: JOB.uid,
      etag: JOB.etag,
      reconciling: false,
      terminalCondition: { state: "CONDITION_SUCCEEDED" },
    };
    const missing = {
      name: JOB.ref,
      uid: JOB.uid,
      etag: JOB.etag,
      reconciling: false,
      terminalCondition: { state: "CONDITION_SUCCEEDED" },
      labels: MANIFEST.labels,
      template: MANIFEST.template,
    };
    const responses = [
      validResponse,
      {
        ...validResponse,
        binaryAuthorization: { useDefault: true, breakglassJustification: "" },
      },
      missing,
      { ...validResponse, binaryAuthorization: { useDefault: false } },
      { ...validResponse, binaryAuthorization: { policy: "projects/p/policy" } },
      {
        ...validResponse,
        binaryAuthorization: {
          useDefault: true,
          breakglassJustification: "unreviewed bypass",
        },
      },
    ];
    const client = new CloudRunJobsClient(
      { projectId: "scribe-phase12", region: "asia-southeast1" },
      { getAccessToken: () => Promise.resolve("token") },
      () => {
        const response = responses.shift();
        if (response === undefined) throw new Error("unexpected request");
        return Promise.resolve(Response.json(response));
      },
    );

    expect(await client.getJob("sd-stg-job")).toEqual({ outcome: "found", job: JOB });
    expect(await client.getJob("sd-stg-job")).toEqual({ outcome: "found", job: JOB });
    expect(await client.getJob("sd-stg-job")).toEqual({ outcome: "unavailable" });
    expect(await client.getJob("sd-stg-job")).toEqual({ outcome: "unavailable" });
    expect(await client.getJob("sd-stg-job")).toEqual({ outcome: "unavailable" });
    expect(await client.getJob("sd-stg-job")).toEqual({ outcome: "unavailable" });
  });

  it("reads an exact scoped asynchronous operation without exposing its raw body", async () => {
    const reference = "projects/scribe-phase12/locations/asia-southeast1/operations/operation-1";
    const client = new CloudRunJobsClient(
      { projectId: "scribe-phase12", region: "asia-southeast1" },
      { getAccessToken: () => Promise.resolve("token") },
      () =>
        Promise.resolve(
          Response.json({ name: reference, done: true, providerMetadata: "discarded" }),
        ),
    );

    expect(await client.getOperation(reference)).toEqual({ outcome: "succeeded" });
  });

  it("refuses mutation references outside the configured project and region", async () => {
    const client = new CloudRunJobsClient(
      { projectId: "scribe-phase12", region: "asia-southeast1" },
      { getAccessToken: () => Promise.resolve("token") },
      () => Promise.reject(new Error("must not fetch")),
    );
    await expect(
      client.runJob({ ...JOB, ref: "projects/other/locations/asia-southeast1/jobs/escaped" }),
    ).rejects.toThrow("provider reference escaped configured scope");
  });
});
