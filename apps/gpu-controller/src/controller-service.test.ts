import { describe, expect, it } from "vitest";
import type { CloudRunControllerAttestationRequest } from "@scribe-drop/contracts";

import type { ControllerClock } from "./authentication.js";
import type { ControllerAction, ControllerRequest } from "./contracts.js";
import {
  InMemoryControlStore,
  defaultSyntheticAuthorizations,
  type ControlStore,
  type SyntheticAuthorization,
} from "./control-store.js";
import { GpuControllerService } from "./controller-service.js";
import {
  createFixedJobManifest,
  type CloudRunAdminPort,
  type CloudRunJobManifest,
  type ProviderExecution,
  type ProviderExecutionList,
  type ProviderJob,
  type ProviderJobRead,
  type ProviderMutation,
} from "./provider.js";

const HANDLE = "h".repeat(43);
const NOW = "2026-08-11T00:00:00.000Z";
const CONFIGURATION = {
  environment: "staging",
  projectId: "scribe-phase12",
  imageDigest: `asia-southeast1-docker.pkg.dev/scribe-phase12/worker/runtime@sha256:${"a".repeat(64)}`,
  runtimeServiceAccount: "runtime@scribe-phase12.iam.gserviceaccount.com",
  orchestratorOrigin: "https://orchestrator.example.test/",
  resultHost: "storage.example.test",
  sourceHost: "storage.example.test",
} as const;

class MutableClock implements ControllerClock {
  value = new Date(NOW);

  now(): Date {
    return new Date(this.value);
  }

  advance(milliseconds: number): void {
    this.value = new Date(this.value.getTime() + milliseconds);
  }
}

class FakeCloudRun implements CloudRunAdminPort {
  readonly jobs = new Map<string, ProviderJob>();
  readonly executions = new Map<string, ProviderExecution[]>();
  createCalls = 0;
  runCalls = 0;
  cancelCalls = 0;
  deleteExecutionCalls = 0;
  deleteJobCalls = 0;
  createAfterEffectUnknown = false;
  runAfterEffectUnknown = false;
  runWithoutEffectUnknown = false;
  cancelAfterEffectUnknown = false;
  deleteAfterEffectUnknown = false;
  createPermanentRejection = false;
  drift = false;

  // The fake keeps the production port asynchronous while applying deterministic effects inline.
  // eslint-disable-next-line @typescript-eslint/require-await
  async createJob(jobId: string, manifest: CloudRunJobManifest): Promise<ProviderMutation> {
    this.createCalls += 1;
    if (this.createPermanentRejection) return { outcome: "rejected", errorKind: "permanent" };
    if (this.jobs.has(jobId)) return { outcome: "conflict" };
    const jobRef = `projects/scribe-phase12/locations/asia-southeast1/jobs/${jobId}`;
    const actualManifest = this.drift
      ? { ...manifest, labels: { ...manifest.labels, "scribe-drop-policy": "drift" } }
      : manifest;
    this.jobs.set(jobId, {
      ref: jobRef,
      uid: "11111111-1111-4111-8111-111111111111",
      etag: "job-etag",
      ready: true,
      manifest: actualManifest,
    });
    this.executions.set(jobId, []);
    return this.createAfterEffectUnknown
      ? { outcome: "unknown" }
      : { outcome: "accepted", operationRef: "operations/create" };
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async runJob(job: ProviderJob): Promise<ProviderMutation> {
    this.runCalls += 1;
    const jobId = job.ref.split("/").at(-1);
    if (jobId === undefined) return { outcome: "rejected", errorKind: "permanent" };
    if (!this.runWithoutEffectUnknown) {
      const current = this.executions.get(jobId) ?? [];
      current.push(this.execution(job, current.length + 1));
      this.executions.set(jobId, current);
    }
    if (this.runAfterEffectUnknown || this.runWithoutEffectUnknown) return { outcome: "unknown" };
    return { outcome: "accepted", operationRef: "operations/run" };
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async cancelExecution(execution: ProviderExecution): Promise<ProviderMutation> {
    this.cancelCalls += 1;
    this.replaceExecution(execution, { ...execution, status: "cancelled" });
    return this.cancelAfterEffectUnknown
      ? { outcome: "unknown" }
      : { outcome: "accepted", operationRef: "operations/cancel" };
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async deleteExecution(execution: ProviderExecution): Promise<ProviderMutation> {
    this.deleteExecutionCalls += 1;
    const jobId = execution.jobRef.split("/").at(-1);
    if (jobId !== undefined) {
      this.executions.set(
        jobId,
        (this.executions.get(jobId) ?? []).filter((item) => item.ref !== execution.ref),
      );
    }
    return this.deleteAfterEffectUnknown
      ? { outcome: "unknown" }
      : { outcome: "accepted", operationRef: "operations/delete-execution" };
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async deleteJob(job: ProviderJob): Promise<ProviderMutation> {
    this.deleteJobCalls += 1;
    const jobId = job.ref.split("/").at(-1);
    if (jobId !== undefined) {
      this.jobs.delete(jobId);
      this.executions.delete(jobId);
    }
    return this.deleteAfterEffectUnknown
      ? { outcome: "unknown" }
      : { outcome: "accepted", operationRef: "operations/delete-job" };
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async getJob(jobId: string): Promise<ProviderJobRead> {
    const job = this.jobs.get(jobId);
    return job === undefined ? { outcome: "not_found" } : { outcome: "found", job };
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async getOperation(): Promise<{ readonly outcome: "succeeded" }> {
    return { outcome: "succeeded" };
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async listExecutions(jobId: string): Promise<ProviderExecutionList> {
    return { outcome: "found", executions: [...(this.executions.get(jobId) ?? [])] };
  }

  addSecondExecution(jobId: string): void {
    const job = this.jobs.get(jobId);
    if (job === undefined) throw new Error("missing fake job");
    const current = this.executions.get(jobId) ?? [];
    current.push(this.execution(job, 2));
    this.executions.set(jobId, current);
  }

  #findJobId(execution: ProviderExecution): string | undefined {
    return execution.jobRef.split("/").at(-1);
  }

  replaceExecution(previous: ProviderExecution, next: ProviderExecution): void {
    const jobId = this.#findJobId(previous);
    if (jobId === undefined) return;
    this.executions.set(
      jobId,
      (this.executions.get(jobId) ?? []).map((item) => (item.ref === previous.ref ? next : item)),
    );
  }

  execution(job: ProviderJob, index: number): ProviderExecution {
    return {
      ref: `${job.ref}/executions/execution-${String(index)}`,
      uid:
        index === 1
          ? "22222222-2222-4222-8222-222222222222"
          : "33333333-3333-4333-8333-333333333333",
      etag: `execution-etag-${String(index)}`,
      jobRef: job.ref,
      status: "pending",
      taskCount: 1,
      parallelism: 1,
      retriedCount: 0,
    };
  }
}

function enabledAuthorization(): Readonly<
  Record<"staging" | "production", SyntheticAuthorization>
> {
  return {
    staging: {
      environment: "staging",
      epoch: "phase12-test",
      validUntil: "2026-08-12T00:00:00.000Z",
      maxExecutions: 1,
      maxWorstCaseJpy: 500,
      maxRequestsPerMinute: 20,
      worstCaseJpyPerExecution: 500,
    },
    production: defaultSyntheticAuthorizations().production,
  };
}

function request(
  action: ControllerAction,
  sequence: number,
  expectedVersion: number,
  environment: "staging" | "production" = "staging",
): ControllerRequest {
  return {
    schemaVersion: 1,
    environment,
    action,
    requestId: `01K28${sequence.toString().padStart(21, "0")}`,
    executionHandle: HANDLE,
    policyId: "cloud_run_jobs_l4_v1",
    expectedVersion,
    issuedAt: NOW,
    expiresAt: "2026-08-11T00:01:00.000Z",
  };
}

function attestationRequest(): CloudRunControllerAttestationRequest {
  return {
    environment: "staging",
    executionHandle: HANDLE,
    expiresAt: "2026-08-11T00:01:00.000Z",
    issuedAt: NOW,
    policyId: "cloud_run_jobs_l4_v1",
    requestId: "01K28000000000000000000999",
    schemaVersion: 1,
  };
}

function service(
  provider: FakeCloudRun,
  clock: MutableClock,
  store: ControlStore = new InMemoryControlStore(enabledAuthorization()),
): { readonly service: GpuControllerService; readonly store: ControlStore } {
  return {
    service: new GpuControllerService({
      environment: "staging",
      manifestConfiguration: CONFIGURATION,
      clock,
      provider,
      store,
    }),
    store,
  };
}

async function createAndReconcile(
  controller: GpuControllerService,
  store: ControlStore,
): Promise<void> {
  await controller.execute(request("create", 1, 0), "digest-create");
  const created = await store.get(HANDLE);
  if (created === null) throw new Error("record missing");
  await controller.execute(request("reconcile", 2, created.version), "digest-reconcile");
}

describe("GPU controller durable lifecycle", () => {
  it("keeps synthetic authorization disabled by default", async () => {
    const provider = new FakeCloudRun();
    const clock = new MutableClock();
    const controller = service(
      provider,
      clock,
      new InMemoryControlStore(defaultSyntheticAuthorizations()),
    ).service;

    const response = await controller.execute(request("create", 1, 0), "digest");

    expect(response).toMatchObject({ outcome: "rejected", errorCode: "BUDGET_EXHAUSTED" });
    expect(provider.createCalls).toBe(0);
  });

  it("admits exactly one fixed-policy create and makes its retry side-effect free", async () => {
    const provider = new FakeCloudRun();
    const clock = new MutableClock();
    const { service: controller } = service(provider, clock);
    const create = request("create", 1, 0);

    const first = await controller.execute(create, "same-digest");
    const duplicate = await controller.execute(create, "same-digest");
    const changedReplay = await controller.execute(create, "changed-digest");

    expect(first.outcome).toBe("pending");
    expect(duplicate).toEqual(first);
    expect(changedReplay).toMatchObject({ outcome: "rejected", errorCode: "CONFLICT" });
    expect(provider.createCalls).toBe(1);
    expect([...provider.jobs.values()][0]?.manifest).toEqual(
      createFixedJobManifest(CONFIGURATION, HANDLE, create.requestId),
    );
  });

  it("rejects wrong environment, stale version, and an exhausted active slot before mutation", async () => {
    const provider = new FakeCloudRun();
    const clock = new MutableClock();
    const { service: controller, store } = service(provider, clock);

    expect(await controller.execute(request("create", 1, 0, "production"), "wrong")).toMatchObject({
      outcome: "rejected",
      errorCode: "ENVIRONMENT_MISMATCH",
    });
    await controller.execute(request("create", 2, 0), "first");
    expect(await controller.execute(request("observe", 3, 1), "stale")).toMatchObject({
      outcome: "rejected",
      errorCode: "STALE_VERSION",
    });
    const record = await store.get(HANDLE);
    expect(record?.reservedWorstCaseJpy).toBe(500);
    expect(provider.createCalls).toBe(1);
  });

  it("enforces the authorization-epoch request rate before a second mutation", async () => {
    const provider = new FakeCloudRun();
    const clock = new MutableClock();
    const authorization = enabledAuthorization();
    const store = new InMemoryControlStore({
      staging: { ...authorization.staging, maxRequestsPerMinute: 1 },
      production: authorization.production,
    });
    const controller = service(provider, clock, store).service;
    await controller.execute(request("create", 1, 0), "create");
    const record = await store.get(HANDLE);
    if (record === null) throw new Error("record missing");

    expect(
      await controller.execute(request("observe", 2, record.version), "observe"),
    ).toMatchObject({ outcome: "rejected", errorCode: "RATE_LIMITED" });
    expect(provider.createCalls).toBe(1);
  });

  it("recovers a create timeout after effect across a controller restart without another Job", async () => {
    const provider = new FakeCloudRun();
    provider.createAfterEffectUnknown = true;
    const clock = new MutableClock();
    const first = service(provider, clock);
    await first.service.execute(request("create", 1, 0), "create");
    const afterCreate = await first.store.get(HANDLE);
    if (afterCreate === null) throw new Error("record missing");

    const restarted = service(provider, clock, first.store).service;
    await restarted.execute(request("reconcile", 2, afterCreate.version), "reconcile");

    expect(provider.createCalls).toBe(1);
    expect(provider.runCalls).toBe(1);
  });

  it("lets only the CAS winner send jobs.run under concurrent reconciliation", async () => {
    const provider = new FakeCloudRun();
    const clock = new MutableClock();
    const lifecycle = service(provider, clock);
    await lifecycle.service.execute(request("create", 1, 0), "create");
    const created = await lifecycle.store.get(HANDLE);
    if (created === null) throw new Error("record missing");

    await Promise.all([
      lifecycle.service.execute(request("reconcile", 2, created.version), "reconcile-a"),
      lifecycle.service.execute(request("reconcile", 3, created.version), "reconcile-b"),
    ]);

    expect(provider.runCalls).toBe(1);
    expect(provider.executions.get(created.jobId)).toHaveLength(1);
  });

  it("does not turn a known permanent create rejection into an automatic retry", async () => {
    const provider = new FakeCloudRun();
    provider.createPermanentRejection = true;
    const clock = new MutableClock();
    const lifecycle = service(provider, clock);
    await lifecycle.service.execute(request("create", 1, 0), "create");
    const failed = await lifecycle.store.get(HANDLE);
    if (failed === null) throw new Error("record missing");
    clock.advance(10_000);

    await lifecycle.service.execute(request("reconcile", 2, failed.version), "reconcile");

    expect(provider.createCalls).toBe(1);
    expect((await lifecycle.store.get(HANDLE))?.errorCode).toBe("PROVIDER_PERMANENT");
  });

  it("never resends jobs.run after either response loss or a lost-before-effect outcome", async () => {
    for (const afterEffect of [true, false]) {
      const provider = new FakeCloudRun();
      provider.runAfterEffectUnknown = afterEffect;
      provider.runWithoutEffectUnknown = !afterEffect;
      const clock = new MutableClock();
      const first = service(provider, clock);
      await createAndReconcile(first.service, first.store);
      const pending = await first.store.get(HANDLE);
      if (pending === null) throw new Error("record missing");

      const restarted = service(provider, clock, first.store).service;
      await restarted.execute(request("reconcile", 3, pending.version), "observe-only");

      expect(provider.runCalls).toBe(1);
      expect((await first.store.get(HANDLE))?.runIntent).toBe(true);
    }
  });

  it("blocks manifest drift and cancels every execution if the one-execution invariant breaks", async () => {
    const driftProvider = new FakeCloudRun();
    driftProvider.drift = true;
    const driftClock = new MutableClock();
    const drift = service(driftProvider, driftClock);
    await createAndReconcile(drift.service, drift.store);
    expect(driftProvider.runCalls).toBe(0);
    expect((await drift.store.get(HANDLE))?.errorCode).toBe("RESOURCE_DRIFT");

    const provider = new FakeCloudRun();
    const clock = new MutableClock();
    const normal = service(provider, clock);
    await createAndReconcile(normal.service, normal.store);
    const record = await normal.store.get(HANDLE);
    if (record === null) throw new Error("record missing");
    provider.addSecondExecution(record.jobId);
    await normal.service.execute(request("reconcile", 4, record.version), "multiple");
    expect(provider.cancelCalls).toBe(2);
    expect((await normal.store.get(HANDLE))?.errorCode).toBe("MULTIPLE_EXECUTIONS");
  });

  it("observes cancel timeout after effect and proves cleanup absence after delete response loss", async () => {
    const provider = new FakeCloudRun();
    provider.cancelAfterEffectUnknown = true;
    provider.deleteAfterEffectUnknown = true;
    const clock = new MutableClock();
    const lifecycle = service(provider, clock);
    await createAndReconcile(lifecycle.service, lifecycle.store);
    let record = await lifecycle.store.get(HANDLE);
    if (record === null) throw new Error("record missing");
    await lifecycle.service.execute(request("observe", 3, record.version), "observe");
    record = await lifecycle.store.get(HANDLE);
    if (record === null) throw new Error("record missing");
    const cancelRequest = request("cancel", 4, record.version);
    await lifecycle.service.execute(cancelRequest, "cancel");
    await lifecycle.service.execute(cancelRequest, "cancel");
    expect(provider.cancelCalls).toBe(1);

    record = await lifecycle.store.get(HANDLE);
    if (record === null) throw new Error("record missing");
    const cleanup = await lifecycle.service.execute(
      request("cleanup", 5, record.version),
      "cleanup",
    );
    expect(cleanup.outcome).toBe("cleaned");
    expect(provider.deleteExecutionCalls).toBe(1);
    expect(provider.deleteJobCalls).toBe(1);
    expect(provider.jobs.size).toBe(0);
  });

  it("re-observes a previously requested cancellation instead of resending it forever", async () => {
    const provider = new FakeCloudRun();
    const clock = new MutableClock();
    const lifecycle = service(provider, clock);
    await createAndReconcile(lifecycle.service, lifecycle.store);
    let record = await lifecycle.store.get(HANDLE);
    const pending = record === null ? undefined : provider.executions.get(record.jobId)?.[0];
    if (record === null || pending === undefined) throw new Error("execution missing");
    provider.replaceExecution(pending, { ...pending, status: "running" });
    await lifecycle.service.execute(request("observe", 3, record.version), "observe-running");
    record = await lifecycle.store.get(HANDLE);
    if (record === null) throw new Error("record missing");

    const first = await lifecycle.service.execute(
      request("cancel", 4, record.version),
      "cancel-first",
    );
    expect(first.outcome).toBe("pending");
    expect(provider.cancelCalls).toBe(1);

    record = await lifecycle.store.get(HANDLE);
    if (record === null) throw new Error("record missing");
    const recovered = await lifecycle.service.execute(
      request("cancel", 5, record.version),
      "cancel-reobserve",
    );

    expect(recovered.outcome).toBe("cancelled");
    expect(provider.cancelCalls).toBe(1);
    expect((await lifecycle.store.get(HANDLE))?.state).toBe("CANCELLED");
  });

  it("reaps only expired or explicitly cleanup-marked records", async () => {
    const provider = new FakeCloudRun();
    const clock = new MutableClock();
    const lifecycle = service(provider, clock);
    await lifecycle.service.execute(request("create", 1, 0), "create");
    expect(await lifecycle.service.reap("staging")).toBe(0);
    clock.advance(5 * 60_000 + 1);
    expect(await lifecycle.service.reap("staging")).toBe(1);
    expect((await lifecycle.store.get(HANDLE))?.state).toBe("CLEANED");
  });

  it("attests one exact live execution without mutating the control record", async () => {
    const provider = new FakeCloudRun();
    const clock = new MutableClock();
    const lifecycle = service(provider, clock);
    await createAndReconcile(lifecycle.service, lifecycle.store);
    let record = await lifecycle.store.get(HANDLE);
    const pending = record === null ? undefined : provider.executions.get(record.jobId)?.[0];
    if (record === null || pending === undefined) throw new Error("execution missing");
    provider.replaceExecution(pending, { ...pending, status: "running" });
    await lifecycle.service.execute(request("observe", 3, record.version), "observe-running");
    record = await lifecycle.store.get(HANDLE);
    if (record === null) throw new Error("record missing");

    await expect(lifecycle.service.attest(attestationRequest())).resolves.toEqual({
      attestation: {
        activeExecutionCount: 1,
        controllerVersion: record.version,
        environment: "staging",
        executionHandle: HANDLE,
        executionName: "execution-1",
        jobName: record.jobId,
        manifestMatches: true,
        policyId: "cloud_run_jobs_l4_v1",
        retriedCount: 0,
        runtimeServiceAccount: CONFIGURATION.runtimeServiceAccount,
        state: "running",
        taskCount: 1,
      },
      executionHandle: HANDLE,
      outcome: "found",
      requestId: attestationRequest().requestId,
      schemaVersion: 1,
    });
    expect((await lifecycle.store.get(HANDLE))?.version).toBe(record.version);
  });

  it("attests the exact live execution before the first observe catches up", async () => {
    const provider = new FakeCloudRun();
    const clock = new MutableClock();
    const lifecycle = service(provider, clock);
    await createAndReconcile(lifecycle.service, lifecycle.store);
    const record = await lifecycle.store.get(HANDLE);
    const pending = record === null ? undefined : provider.executions.get(record.jobId)?.[0];
    if (record === null || pending === undefined) throw new Error("execution missing");
    expect(record).toMatchObject({
      execution: null,
      runIntent: true,
      state: "EXECUTION_PENDING",
    });
    provider.replaceExecution(pending, { ...pending, status: "running" });

    await expect(lifecycle.service.attest(attestationRequest())).resolves.toMatchObject({
      attestation: {
        activeExecutionCount: 1,
        manifestMatches: true,
        state: "running",
      },
      outcome: "found",
    });
    expect((await lifecycle.store.get(HANDLE))?.version).toBe(record.version);
  });

  it("rejects a pre-observe execution without durable run intent", async () => {
    const provider = new FakeCloudRun();
    const clock = new MutableClock();
    const lifecycle = service(provider, clock);
    await createAndReconcile(lifecycle.service, lifecycle.store);
    const record = await lifecycle.store.get(HANDLE);
    const pending = record === null ? undefined : provider.executions.get(record.jobId)?.[0];
    if (record === null || pending === undefined) throw new Error("execution missing");
    expect(
      await lifecycle.store.compareAndSet(record.version, {
        ...record,
        runIntent: false,
        version: record.version + 1,
      }),
    ).toBe(true);
    provider.replaceExecution(pending, { ...pending, status: "running" });

    await expect(lifecycle.service.attest(attestationRequest())).resolves.toMatchObject({
      attestation: { manifestMatches: false },
      outcome: "found",
    });
  });

  it("reports live manifest drift and refuses ambiguous execution lists", async () => {
    const provider = new FakeCloudRun();
    const clock = new MutableClock();
    const lifecycle = service(provider, clock);
    await createAndReconcile(lifecycle.service, lifecycle.store);
    let record = await lifecycle.store.get(HANDLE);
    const pending = record === null ? undefined : provider.executions.get(record.jobId)?.[0];
    const job = record === null ? undefined : provider.jobs.get(record.jobId);
    if (record === null || pending === undefined || job === undefined) {
      throw new Error("provider resource missing");
    }
    provider.replaceExecution(pending, { ...pending, status: "running" });
    await lifecycle.service.execute(request("observe", 3, record.version), "observe-running");
    provider.jobs.set(record.jobId, {
      ...job,
      manifest: { ...job.manifest, labels: { ...job.manifest.labels, drift: "true" } },
    });
    await expect(lifecycle.service.attest(attestationRequest())).resolves.toMatchObject({
      attestation: { manifestMatches: false },
      outcome: "found",
    });

    record = await lifecycle.store.get(HANDLE);
    if (record === null) throw new Error("record missing");
    provider.addSecondExecution(record.jobId);
    await expect(lifecycle.service.attest(attestationRequest())).resolves.toEqual({
      attestation: null,
      executionHandle: HANDLE,
      outcome: "invariant_failure",
      requestId: attestationRequest().requestId,
      schemaVersion: 1,
    });
  });
});
