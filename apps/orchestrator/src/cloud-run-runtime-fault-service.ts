import { cloudRunOpaqueHandleSchema, ulidSchema } from "@scribe-drop/contracts";
import { z } from "zod";

import type { CloudRunRuntimeHttpService } from "./cloud-run-runtime-http.js";
import {
  matchesStagingAcceptanceFault,
  type StagingAcceptanceFaultConfig,
} from "./staging-acceptance-fault.js";

const targetRowSchema = z.object({ job_id: ulidSchema }).strict();

const FIND_TARGET_JOB_SQL = `
  SELECT jobs.id AS job_id
  FROM provider_executions AS executions
  INNER JOIN job_attempts AS attempts ON attempts.id = executions.attempt_id
  INNER JOIN jobs ON jobs.id = attempts.job_id
  WHERE executions.provider_kind = 'cloud_run_jobs'
    AND executions.provider_policy = 'cloud_run_jobs_l4_v1'
    AND executions.provider_handle = ?1
    AND jobs.active_attempt_id = attempts.id
  LIMIT 1
`;

export interface RuntimeFaultClock {
  now(): Date;
}

export interface RuntimeFaultTargetRepository {
  findJobId(executionHandle: string): Promise<string | undefined>;
}

export function createD1RuntimeFaultTargetRepository(
  database: D1Database,
): RuntimeFaultTargetRepository {
  return {
    async findJobId(executionHandle) {
      const row = await database
        .prepare(FIND_TARGET_JOB_SQL)
        .bind(cloudRunOpaqueHandleSchema.parse(executionHandle))
        .first();
      if (row === null) return undefined;
      return targetRowSchema.parse(row).job_id;
    },
  };
}

export function createStagingAcceptanceRuntimeService(
  service: CloudRunRuntimeHttpService,
  config: StagingAcceptanceFaultConfig | undefined,
  repository: RuntimeFaultTargetRepository,
  clock: RuntimeFaultClock,
): CloudRunRuntimeHttpService {
  async function matches(
    executionHandle: string,
    fault: "runtime_heartbeat_response_loss" | "worker_disconnect_after_claim",
  ): Promise<boolean> {
    if (config?.fault !== fault) return false;
    const jobId = await repository.findJobId(executionHandle);
    return jobId !== undefined && matchesStagingAcceptanceFault(config, fault, jobId, clock.now());
  }

  return {
    acknowledge: async (request) => {
      const result = await service.acknowledge(request);
      if (await matches(request.executionHandle, "worker_disconnect_after_claim")) {
        throw new Error("Staging acceptance runtime connection is unavailable");
      }
      return result;
    },
    bootstrap: (request) => service.bootstrap(request),
    claim: (request) => service.claim(request),
    heartbeat: async (request) => {
      const result = await service.heartbeat(request);
      if (await matches(request.executionHandle, "runtime_heartbeat_response_loss")) {
        throw new Error("Staging acceptance heartbeat response was lost");
      }
      return result;
    },
    terminal: (request) => service.terminal(request),
  };
}
