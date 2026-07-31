import { handleGetArtifact } from "../../../../../src/server/jobs/job-handlers.js";
import type { WebPagesFunction } from "../../../../../src/server/web-context.js";

export const onRequestGet: WebPagesFunction<"format" | "id"> = (context) =>
  handleGetArtifact(context);
