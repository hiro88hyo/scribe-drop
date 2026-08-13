import { describe, expect, it } from "vitest";

import type {
  AdmitCreateInput,
  ClaimRequestInput,
  ControlRecord,
  SyntheticAuthorization,
} from "./control-store.js";
import {
  FirestoreControlStore,
  createFirestoreEnvironmentDocument,
  type FirestoreControlDatabase,
  type FirestoreDocumentTransaction,
} from "./firestore-control-store.js";

const NOW = "2026-08-11T00:00:00.000Z";
const HANDLE = "h".repeat(43);
const ENVIRONMENT_PATH = "scribe_drop_controller_environments/staging";

function authorization(overrides: Partial<SyntheticAuthorization> = {}): SyntheticAuthorization {
  return {
    environment: "staging",
    epoch: "phase14-local-firestore",
    maxExecutions: 2,
    maxRequestsPerMinute: 10,
    maxWorstCaseJpy: 1_000,
    validUntil: "2026-08-12T00:00:00.000Z",
    worstCaseJpyPerExecution: 500,
    ...overrides,
  };
}

function createInput(
  sequence = 1,
  executionHandle = HANDLE,
  digest = "d".repeat(43),
): AdmitCreateInput {
  return {
    action: "create",
    digest,
    environment: "staging",
    executionHandle,
    expectedVersion: 0,
    jobId: `sd-stg-${sequence.toString(16).padStart(30, "0")}`,
    now: NOW,
    provisioningDeadline: "2026-08-11T00:05:00.000Z",
    recordExpiresAt: "2026-09-11T00:00:00.000Z",
    requestId: `01K2800000000000000000000${String(sequence)}`,
  };
}

function claimInput(
  sequence: number,
  expectedVersion: number,
  digest = "c".repeat(43),
): ClaimRequestInput {
  return {
    action: "observe",
    digest,
    environment: "staging",
    executionHandle: HANDLE,
    expectedVersion,
    now: new Date(Date.parse(NOW) + sequence * 1_000).toISOString(),
    requestId: `01K2800000000000000000001${String(sequence)}`,
  };
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

class FakeTransaction implements FirestoreDocumentTransaction {
  readonly #base: ReadonlyMap<string, unknown>;
  readonly creates = new Map<string, unknown>();
  readonly sets = new Map<string, unknown>();

  constructor(base: ReadonlyMap<string, unknown>) {
    this.#base = base;
  }

  create(path: string, data: Readonly<Record<string, unknown>>): void {
    if (this.#base.has(path) || this.creates.has(path)) throw new Error("document exists");
    this.creates.set(path, clone(data));
  }

  // The fake mirrors an asynchronous remote document read.
  // eslint-disable-next-line @typescript-eslint/require-await
  async get(path: string): Promise<unknown> {
    return clone(this.sets.get(path) ?? this.creates.get(path) ?? this.#base.get(path) ?? null);
  }

  set(path: string, data: Readonly<Record<string, unknown>>): void {
    this.sets.set(path, clone(data));
  }
}

class FakeFirestoreDatabase implements FirestoreControlDatabase {
  readonly documents = new Map<string, unknown>();
  retryNextTransaction = false;
  #tail: Promise<void> = Promise.resolve();

  seed(path: string, data: Readonly<Record<string, unknown>>): void {
    this.documents.set(path, clone(data));
  }

  // The fake mirrors an asynchronous remote document read.
  // eslint-disable-next-line @typescript-eslint/require-await
  async get(path: string): Promise<unknown> {
    return clone(this.documents.get(path) ?? null);
  }

  runTransaction<T>(
    callback: (transaction: FirestoreDocumentTransaction) => Promise<T>,
  ): Promise<T> {
    const work = this.#tail.then(() => this.#execute(callback));
    this.#tail = work.then(
      () => undefined,
      () => undefined,
    );
    return work;
  }

  async #execute<T>(
    callback: (transaction: FirestoreDocumentTransaction) => Promise<T>,
  ): Promise<T> {
    if (this.retryNextTransaction) {
      this.retryNextTransaction = false;
      await callback(new FakeTransaction(this.documents));
    }
    const transaction = new FakeTransaction(this.documents);
    const result = await callback(transaction);
    for (const [path, value] of transaction.creates) this.documents.set(path, clone(value));
    for (const [path, value] of transaction.sets) this.documents.set(path, clone(value));
    return result;
  }
}

function store(
  fixedAuthorization = authorization(),
  database = new FakeFirestoreDatabase(),
): { readonly database: FakeFirestoreDatabase; readonly store: FirestoreControlStore } {
  database.seed(ENVIRONMENT_PATH, createFirestoreEnvironmentDocument(fixedAuthorization, NOW));
  return { database, store: new FirestoreControlStore(fixedAuthorization, database) };
}

describe("FirestoreControlStore", () => {
  it("keeps default authorization disabled before creating any durable record", async () => {
    const disabled = authorization({
      epoch: "disabled",
      maxExecutions: 0,
      maxRequestsPerMinute: 0,
      maxWorstCaseJpy: 0,
      validUntil: "1970-01-01T00:00:00.000Z",
      worstCaseJpyPerExecution: 0,
    });
    const lifecycle = store(disabled);

    await expect(lifecycle.store.admitCreate(createInput())).resolves.toEqual({
      outcome: "budget_exhausted",
    });
    expect(lifecycle.database.documents).toHaveLength(1);
  });

  it("atomically reserves one create and allows only exact request replay", async () => {
    const lifecycle = store();
    const input = createInput();

    const accepted = await lifecycle.store.admitCreate(input);
    await expect(lifecycle.store.admitCreate(input)).resolves.toEqual({
      outcome: "duplicate",
      record: accepted.outcome === "accepted" ? accepted.record : undefined,
    });
    await expect(
      lifecycle.store.admitCreate({ ...input, digest: "e".repeat(43) }),
    ).resolves.toEqual({ outcome: "conflict" });
    expect(accepted).toMatchObject({
      outcome: "accepted",
      record: { reservedWorstCaseJpy: 500, state: "CREATE_INTENT", version: 1 },
    });
    expect(lifecycle.database.documents.get(ENVIRONMENT_PATH)).toMatchObject({
      activeExecutionHandle: HANDLE,
      activeExecutions: 1,
      reservedExecutions: 1,
      reservedWorstCaseJpy: 500,
    });
    expect(
      lifecycle.database.documents.get(`scribe_drop_controller_requests/${input.requestId}`),
    ).toMatchObject({ ttlExpiresAt: new Date(input.recordExpiresAt) });
  });

  it("serializes concurrent admission and SDK transaction callback retry", async () => {
    const lifecycle = store();
    lifecycle.database.retryNextTransaction = true;
    const secondHandle = "i".repeat(43);

    const results = await Promise.all([
      lifecycle.store.admitCreate(createInput(1)),
      lifecycle.store.admitCreate(createInput(2, secondHandle, "e".repeat(43))),
    ]);

    expect(results.map((result) => result.outcome).sort()).toEqual([
      "accepted",
      "budget_exhausted",
    ]);
    expect(
      [...lifecycle.database.documents.keys()].filter((path) =>
        path.startsWith("scribe_drop_controller_executions/"),
      ),
    ).toHaveLength(1);
  });

  it("persists claim identity, exact replay, stale version, and rate limit", async () => {
    const lifecycle = store(authorization({ maxRequestsPerMinute: 2 }));
    await lifecycle.store.admitCreate(createInput());
    const claim = claimInput(1, 1);

    const accepted = await lifecycle.store.claimRequest(claim);
    expect(accepted).toMatchObject({ outcome: "accepted" });
    await expect(lifecycle.store.claimRequest(claim)).resolves.toEqual({
      outcome: "duplicate",
      record: accepted.outcome === "accepted" ? accepted.record : undefined,
    });
    const stale = await lifecycle.store.claimRequest(claimInput(2, 0));
    expect(stale.outcome).toBe("stale");
    if (stale.outcome !== "stale") throw new Error("expected stale controller version");
    expect(stale.record.version).toBe(1);
    await expect(lifecycle.store.claimRequest(claimInput(3, 1))).resolves.toEqual({
      outcome: "rate_limited",
    });
  });

  it("allows one CAS winner and releases only the active slot after exact cleanup", async () => {
    const lifecycle = store();
    await lifecycle.store.admitCreate(createInput());
    const current = await lifecycle.store.get(HANDLE);
    if (current === null) throw new Error("missing control record");
    const next: ControlRecord = {
      ...current,
      state: "JOB_PENDING",
      updatedAt: "2026-08-11T00:00:01.000Z",
      version: 2,
    };

    await expect(
      Promise.all([lifecycle.store.compareAndSet(1, next), lifecycle.store.compareAndSet(1, next)]),
    ).resolves.toEqual([true, false]);
    await expect(
      lifecycle.store.compareAndSet(2, {
        ...next,
        jobId: `sd-stg-${"f".repeat(30)}`,
        updatedAt: "2026-08-11T00:00:02.000Z",
        version: 3,
      }),
    ).resolves.toBe(false);
    const cleaned: ControlRecord = {
      ...next,
      state: "CLEANED",
      updatedAt: "2026-08-11T00:00:02.000Z",
      version: 3,
    };
    await expect(lifecycle.store.compareAndSet(2, cleaned)).resolves.toBe(true);
    await expect(lifecycle.store.listUnclean("staging")).resolves.toEqual([]);
    expect(lifecycle.database.documents.get(ENVIRONMENT_PATH)).toMatchObject({
      activeExecutionHandle: null,
      activeExecutions: 0,
      reservedExecutions: 1,
      reservedWorstCaseJpy: 500,
    });
  });

  it("survives adapter restart and fails closed on durable authorization drift", async () => {
    const lifecycle = store();
    await lifecycle.store.admitCreate(createInput());
    const restarted = new FirestoreControlStore(authorization(), lifecycle.database);

    await expect(restarted.get(HANDLE)).resolves.toMatchObject({ state: "CREATE_INTENT" });
    await expect(restarted.listUnclean("staging")).resolves.toHaveLength(1);
    const environment = lifecycle.database.documents.get(ENVIRONMENT_PATH);
    if (typeof environment !== "object" || environment === null) {
      throw new Error("missing environment document");
    }
    lifecycle.database.documents.set(ENVIRONMENT_PATH, {
      ...environment,
      maxWorstCaseJpy: 999,
    });
    await expect(restarted.listUnclean("staging")).rejects.toThrow(
      "Firestore controller authorization mismatch",
    );
  });

  it("fails closed on path, TTL, and active-singleton persistence drift", async () => {
    const lifecycle = store();
    await lifecycle.store.admitCreate(createInput());
    const executionPath = `scribe_drop_controller_executions/${HANDLE}`;
    const execution = lifecycle.database.documents.get(executionPath);
    if (typeof execution !== "object" || execution === null || !("record" in execution)) {
      throw new Error("missing execution document");
    }
    const record = execution.record;
    if (typeof record !== "object" || record === null) throw new Error("missing record");

    lifecycle.database.documents.set(executionPath, {
      ...execution,
      record: { ...record, executionHandle: "i".repeat(43) },
    });
    await expect(lifecycle.store.get(HANDLE)).rejects.toThrow(
      "Firestore controller record path binding mismatch",
    );

    lifecycle.database.documents.set(executionPath, {
      ...execution,
      ttlExpiresAt: new Date("2026-09-12T00:00:00.000Z"),
    });
    await expect(lifecycle.store.get(HANDLE)).rejects.toThrow(
      "execution TTL must match record expiry",
    );

    lifecycle.database.documents.set(executionPath, execution);
    const environment = lifecycle.database.documents.get(ENVIRONMENT_PATH);
    if (typeof environment !== "object" || environment === null) {
      throw new Error("missing environment document");
    }
    lifecycle.database.documents.set(ENVIRONMENT_PATH, {
      ...environment,
      activeExecutions: 0,
    });
    await expect(lifecycle.store.listUnclean("staging")).rejects.toThrow(
      "active count and execution handle must agree",
    );
  });
});
