import { handleUploadQueueBatch, type UploadQueueEnvironment } from "./upload-queue-consumer.js";
import { handleRunpodHttpRequest, type RunpodHttpEnvironment } from "./runpod-http-handler.js";
import { submitPendingRunpodJob } from "./runpod-submission-service.js";

export const ORCHESTRATOR_APPLICATION_ID = "scribe-drop-orchestrator";

export default {
  async fetch(request, environment): Promise<Response> {
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
} satisfies ExportedHandler<UploadQueueEnvironment & RunpodHttpEnvironment>;
