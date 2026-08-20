import { ulidSchema, utcDateTimeSchema } from "@scribe-drop/contracts";
import { z } from "zod";

const MAX_FAULT_LIFETIME_MS = 30 * 60 * 1_000;
const CLOCK_SKEW_MS = 60 * 1_000;

export const STAGING_ACCEPTANCE_FAULTS = [
  "notification_unavailable",
  "runtime_heartbeat_response_loss",
  "worker_disconnect_after_claim",
] as const;

const stagingAcceptanceFaultSchema = z
  .object({
    appEnvironment: z.literal("staging"),
    expiresAt: utcDateTimeSchema,
    fault: z.enum(STAGING_ACCEPTANCE_FAULTS),
    issuedAt: utcDateTimeSchema,
    jobId: ulidSchema,
  })
  .strict()
  .refine(
    ({ expiresAt, issuedAt }) => {
      const lifetime = Date.parse(expiresAt) - Date.parse(issuedAt);
      return lifetime > 0 && lifetime <= MAX_FAULT_LIFETIME_MS;
    },
    { message: "Staging acceptance fault lifetime is invalid" },
  );

export type StagingAcceptanceFault = (typeof STAGING_ACCEPTANCE_FAULTS)[number];

export interface StagingAcceptanceFaultEnvironment {
  readonly APP_ENV: string;
  readonly STAGING_ACCEPTANCE_FAULT?: string;
  readonly STAGING_ACCEPTANCE_FAULT_EXPIRES_AT?: string;
  readonly STAGING_ACCEPTANCE_FAULT_ISSUED_AT?: string;
  readonly STAGING_ACCEPTANCE_FAULT_JOB_ID?: string;
}

export interface StagingAcceptanceFaultConfig {
  readonly appEnvironment: "staging";
  readonly expiresAt: string;
  readonly fault: StagingAcceptanceFault;
  readonly issuedAt: string;
  readonly jobId: string;
}

/**
 * An absent lease disables the harness. Any partial, malformed, or non-staging lease is a
 * deployment error instead of silently falling back to normal behavior.
 */
export function parseStagingAcceptanceFault(
  environment: StagingAcceptanceFaultEnvironment,
): StagingAcceptanceFaultConfig | undefined {
  const values = [
    environment.STAGING_ACCEPTANCE_FAULT,
    environment.STAGING_ACCEPTANCE_FAULT_EXPIRES_AT,
    environment.STAGING_ACCEPTANCE_FAULT_ISSUED_AT,
    environment.STAGING_ACCEPTANCE_FAULT_JOB_ID,
  ];
  if (values.every((value) => value === undefined)) return undefined;

  const result = stagingAcceptanceFaultSchema.safeParse({
    appEnvironment: environment.APP_ENV,
    expiresAt: environment.STAGING_ACCEPTANCE_FAULT_EXPIRES_AT,
    fault: environment.STAGING_ACCEPTANCE_FAULT,
    issuedAt: environment.STAGING_ACCEPTANCE_FAULT_ISSUED_AT,
    jobId: environment.STAGING_ACCEPTANCE_FAULT_JOB_ID,
  });
  if (!result.success) throw new Error("Staging acceptance fault configuration is invalid");
  return result.data;
}

export function matchesStagingAcceptanceFault(
  config: StagingAcceptanceFaultConfig | undefined,
  expectedFault: StagingAcceptanceFault,
  jobId: string,
  now: Date,
): boolean {
  if (config?.fault !== expectedFault) return false;
  if (config.jobId !== jobId) return false;
  const timestamp = now.getTime();
  return (
    timestamp >= Date.parse(config.issuedAt) - CLOCK_SKEW_MS &&
    timestamp < Date.parse(config.expiresAt)
  );
}
