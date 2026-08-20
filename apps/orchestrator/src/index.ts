import { handleCloudRunRuntimeShadowRequest } from "./cloud-run-runtime-shadow.js";
import {
  createCloudRunRuntimeService,
  type CloudRunRuntimeCompositionEnvironment,
} from "./cloud-run-runtime-composition.js";
import { handleUploadQueueBatch, type UploadQueueEnvironment } from "./upload-queue-consumer.js";
import { handleRunpodHttpRequest, type RunpodHttpEnvironment } from "./runpod-http-handler.js";
import { reconcileJobs, type ReconciliationEnvironment } from "./reconciliation-service.js";
import { submitPendingRunpodJob } from "./runpod-submission-service.js";
import { parseRunpodConfig } from "./config.js";
import { submitPendingCloudRunJob } from "./cloud-run-submission-service.js";

export const ORCHESTRATOR_APPLICATION_ID = "scribe-drop-orchestrator";

export default {
  async fetch(request, environment): Promise<Response> {
    const shadowResponse = await handleCloudRunRuntimeShadowRequest(
      request,
      environment,
      createCloudRunRuntimeService(environment),
    );
    if (shadowResponse !== undefined) return shadowResponse;
    return handleRunpodHttpRequest(request, environment);
  },

  async queue(batch, environment): Promise<void> {
    await handleUploadQueueBatch(batch, environment, {
      submitPendingJob: (jobId, database, selection, logger) => {
        if (selection.kind === "cloud_run_jobs") {
          return submitPendingCloudRunJob(
            jobId,
            { ...environment, SCRIBE_DROP_DB: database },
            { logger },
          );
        }
        const config = parseRunpodConfig(environment);
        if (config === undefined) throw new Error("RunPod submission configuration is invalid");
        return submitPendingRunpodJob(
          jobId,
          {
            RUNPOD_API_KEY: config.runpodApiKey,
            RUNPOD_ENDPOINT_ID: config.runpodEndpointId,
            SCRIBE_DROP_DB: database,
          },
          { logger },
        );
      },
    });
  },

  async scheduled(_controller, environment): Promise<void> {
    await reconcileJobs(environment);
  },
} satisfies ExportedHandler<
  UploadQueueEnvironment &
    RunpodHttpEnvironment &
    ReconciliationEnvironment &
    CloudRunRuntimeCompositionEnvironment
>;
