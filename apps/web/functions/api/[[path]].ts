import { createApiErrorResponse } from "../../src/server/http/api-error.js";
import type { WebPagesFunction } from "../../src/server/web-context.js";

const NOT_FOUND_MESSAGE = "指定されたAPIは存在しません。";

export const onRequest: WebPagesFunction<"path"> = ({ data }) =>
  createApiErrorResponse({
    code: "NOT_FOUND",
    message: NOT_FOUND_MESSAGE,
    requestId: data.requestId ?? crypto.randomUUID(),
    status: 404,
  });
