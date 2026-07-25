import { createApiBoundaryMiddleware } from "../../src/server/http/api-boundary.js";

export const onRequest = createApiBoundaryMiddleware();
