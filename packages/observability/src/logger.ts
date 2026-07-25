export const LOG_LEVELS = ["debug", "info", "warn", "error"] as const;
export const LOG_SERVICES = ["web", "orchestrator", "runpod-worker"] as const;
export const DEPLOYMENT_ENVIRONMENTS = ["local", "staging", "production"] as const;

export type LogLevel = (typeof LOG_LEVELS)[number];
export type LogService = (typeof LOG_SERVICES)[number];
export type DeploymentEnvironment = (typeof DEPLOYMENT_ENVIRONMENTS)[number];

export interface SafeLogContext {
  attemptId?: string;
  elapsedMs?: number;
  errorCode?: string;
  jobId?: string;
  ownerHash?: string;
  requestId?: string;
  runpodJobId?: string;
  sizeBytes?: number;
  status?: string;
}

export interface StructuredLogRecord extends SafeLogContext {
  environment: DeploymentEnvironment;
  event: string;
  level: LogLevel;
  service: LogService;
  timestamp: string;
}

export type LogSink = (serializedRecord: string) => void;

export interface StructuredLoggerOptions {
  readonly environment: DeploymentEnvironment;
  readonly now?: () => Date;
  readonly service: LogService;
  readonly sink: LogSink;
}

export interface StructuredLogger {
  debug(event: string, context?: SafeLogContext): StructuredLogRecord;
  error(event: string, context?: SafeLogContext): StructuredLogRecord;
  info(event: string, context?: SafeLogContext): StructuredLogRecord;
  warn(event: string, context?: SafeLogContext): StructuredLogRecord;
}

const ULID_PATTERN = /^[0-9A-HJKMNP-TV-Z]{26}$/u;
const SAFE_IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,199}$/u;
const SAFE_CODE_PATTERN = /^[A-Z][A-Z0-9_]{0,63}$/u;
const SAFE_EVENT_PATTERN = /^[a-z][a-z0-9_.-]{0,99}$/u;
const OWNER_HASH_PATTERN = /^[a-f0-9]{16,64}$/u;
const INVALID_EVENT_NAME = "invalid_log_event";

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function matches(value: unknown, pattern: RegExp): value is string {
  return typeof value === "string" && pattern.test(value);
}

function normalizeEvent(event: string): string {
  return SAFE_EVENT_PATTERN.test(event) ? event : INVALID_EVENT_NAME;
}

export function sanitizeLogContext(value: unknown): SafeLogContext {
  if (!isRecord(value)) {
    return {};
  }

  const sanitized: SafeLogContext = {};

  if (matches(value["attemptId"], ULID_PATTERN)) {
    sanitized.attemptId = value["attemptId"];
  }
  if (isSafeInteger(value["elapsedMs"])) {
    sanitized.elapsedMs = value["elapsedMs"];
  }
  if (matches(value["errorCode"], SAFE_CODE_PATTERN)) {
    sanitized.errorCode = value["errorCode"];
  }
  if (matches(value["jobId"], ULID_PATTERN)) {
    sanitized.jobId = value["jobId"];
  }
  if (matches(value["ownerHash"], OWNER_HASH_PATTERN)) {
    sanitized.ownerHash = value["ownerHash"];
  }
  if (matches(value["requestId"], SAFE_IDENTIFIER_PATTERN)) {
    sanitized.requestId = value["requestId"];
  }
  if (matches(value["runpodJobId"], SAFE_IDENTIFIER_PATTERN)) {
    sanitized.runpodJobId = value["runpodJobId"];
  }
  if (isSafeInteger(value["sizeBytes"])) {
    sanitized.sizeBytes = value["sizeBytes"];
  }
  if (matches(value["status"], SAFE_CODE_PATTERN)) {
    sanitized.status = value["status"];
  }

  return sanitized;
}

class JsonStructuredLogger implements StructuredLogger {
  readonly #environment: DeploymentEnvironment;
  readonly #now: () => Date;
  readonly #service: LogService;
  readonly #sink: LogSink;

  constructor(options: StructuredLoggerOptions) {
    this.#environment = options.environment;
    this.#now = options.now ?? (() => new Date());
    this.#service = options.service;
    this.#sink = options.sink;
  }

  debug(event: string, context?: SafeLogContext): StructuredLogRecord {
    return this.#write("debug", event, context);
  }

  error(event: string, context?: SafeLogContext): StructuredLogRecord {
    return this.#write("error", event, context);
  }

  info(event: string, context?: SafeLogContext): StructuredLogRecord {
    return this.#write("info", event, context);
  }

  warn(event: string, context?: SafeLogContext): StructuredLogRecord {
    return this.#write("warn", event, context);
  }

  #write(level: LogLevel, event: string, context?: SafeLogContext): StructuredLogRecord {
    const record: StructuredLogRecord = {
      environment: this.#environment,
      event: normalizeEvent(event),
      level,
      service: this.#service,
      timestamp: this.#now().toISOString(),
      ...sanitizeLogContext(context),
    };
    this.#sink(JSON.stringify(record));
    return record;
  }
}

export function createStructuredLogger(options: StructuredLoggerOptions): StructuredLogger {
  return new JsonStructuredLogger(options);
}
