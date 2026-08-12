import { handleCloudRunRuntimeShadowRequest } from "./cloud-run-runtime-shadow.js";
import {
  createCloudRunRuntimeService,
  type CloudRunRuntimeCompositionEnvironment,
} from "./cloud-run-runtime-composition.js";
import { handleUploadQueueBatch, type UploadQueueEnvironment } from "./upload-queue-consumer.js";
import { handleRunpodHttpRequest, type RunpodHttpEnvironment } from "./runpod-http-handler.js";
import { reconcileJobs, type ReconciliationEnvironment } from "./reconciliation-service.js";
import { submitPendingRunpodJob } from "./runpod-submission-service.js";

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
      submitPendingJob: (jobId, database, config, logger) =>
        submitPendingRunpodJob(
          jobId,
          {
            RUNPOD_API_KEY: config.runpodApiKey,
            RUNPOD_ENDPOINT_ID: config.runpodEndpointId,
            SCRIBE_DROP_DB: database,
          },
          { logger },
        ),
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
