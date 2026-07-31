import { handleUploadComplete } from "../../../../src/server/jobs/job-handlers.js";
import type { WebPagesFunction } from "../../../../src/server/web-context.js";

export const onRequestPost: WebPagesFunction<"id"> = (context) => handleUploadComplete(context);
