import { handleCreateJob, handleListJobs } from "../../src/server/jobs/job-handlers.js";
import type { WebPagesFunction } from "../../src/server/web-context.js";

export const onRequestGet: WebPagesFunction = (context) => handleListJobs(context);

export const onRequestPost: WebPagesFunction = (context) => handleCreateJob(context);
