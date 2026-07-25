import { handleUploadQueueBatch, type UploadQueueEnvironment } from "./upload-queue-consumer.js";

export const ORCHESTRATOR_APPLICATION_ID = "scribe-drop-orchestrator";

export default {
  fetch(): Response {
    return new Response(null, { status: 404 });
  },

  async queue(batch, environment): Promise<void> {
    await handleUploadQueueBatch(batch, environment);
  },
} satisfies ExportedHandler<UploadQueueEnvironment>;
