export interface FaultStep<Point extends string> {
  readonly occurrences: readonly number[];
  readonly point: Point;
}

export class InjectedFaultError<Point extends string> extends Error {
  readonly occurrence: number;
  readonly point: Point;

  constructor(point: Point, occurrence: number) {
    super(`Injected fault at ${point} occurrence ${String(occurrence)}`);
    this.name = "InjectedFaultError";
    this.occurrence = occurrence;
    this.point = point;
  }
}

export class DeterministicFaultPlan<Point extends string> {
  readonly #calls = new Map<Point, number>();
  readonly #scheduled = new Map<Point, ReadonlySet<number>>();

  constructor(steps: readonly FaultStep<Point>[]) {
    for (const step of steps) {
      if (this.#scheduled.has(step.point)) {
        throw new Error(`Duplicate fault point: ${step.point}`);
      }
      const occurrences = new Set<number>();
      for (const occurrence of step.occurrences) {
        if (!Number.isSafeInteger(occurrence) || occurrence < 1) {
          throw new Error("Fault occurrences must be positive safe integers");
        }
        occurrences.add(occurrence);
      }
      this.#scheduled.set(step.point, occurrences);
    }
  }

  count(point: Point): number {
    return this.#calls.get(point) ?? 0;
  }

  hit(point: Point): void {
    const occurrence = this.count(point) + 1;
    this.#calls.set(point, occurrence);
    if (this.#scheduled.get(point)?.has(occurrence) === true) {
      throw new InjectedFaultError(point, occurrence);
    }
  }

  async before<Result>(point: Point, operation: () => Promise<Result>): Promise<Result> {
    this.hit(point);
    return operation();
  }

  async after<Result>(point: Point, operation: () => Promise<Result>): Promise<Result> {
    const result = await operation();
    this.hit(point);
    return result;
  }

  assertExhausted(): void {
    for (const [point, occurrences] of this.#scheduled) {
      const calls = this.count(point);
      for (const occurrence of occurrences) {
        if (occurrence > calls) {
          throw new Error(`Fault at ${point} occurrence ${String(occurrence)} was not exercised`);
        }
      }
    }
  }
}

export interface StructuredLogInspection {
  readonly events: readonly string[];
  readonly recordCount: number;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function inspectStructuredLogs(
  records: readonly string[],
  forbiddenFragments: readonly string[],
): StructuredLogInspection {
  const events: string[] = [];
  for (const serialized of records) {
    for (const fragment of forbiddenFragments) {
      if (fragment.length === 0) {
        throw new Error("Forbidden log fragments must not be empty");
      }
      if (serialized.includes(fragment)) {
        throw new Error("A forbidden fragment was found in structured logs");
      }
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(serialized);
    } catch {
      throw new Error("A structured log record is not valid JSON");
    }
    if (
      !isRecord(parsed) ||
      typeof parsed["environment"] !== "string" ||
      typeof parsed["event"] !== "string" ||
      typeof parsed["level"] !== "string" ||
      typeof parsed["service"] !== "string" ||
      typeof parsed["timestamp"] !== "string"
    ) {
      throw new Error("A structured log record is missing its required envelope");
    }
    events.push(parsed["event"]);
  }
  return {
    events,
    recordCount: records.length,
  };
}
