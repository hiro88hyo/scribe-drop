import { handleGetJob } from "../../../src/server/jobs/job-handlers.js";
import type { WebPagesFunction } from "../../../src/server/web-context.js";

export const onRequestGet: WebPagesFunction<"id"> = (context) => handleGetJob(context);
