import {
  handleCloudRunRuntimeRequest,
  type CloudRunRuntimeHttpService,
} from "./cloud-run-runtime-http.js";
import {
  parseCloudRunRuntimeShadowConfig,
  type CloudRunRuntimeShadowConfigEnvironment,
} from "./config.js";

const CLOUD_RUN_RUNTIME_PREFIX = "/internal/cloud-run/";
export type CloudRunRuntimeShadowEnvironment = CloudRunRuntimeShadowConfigEnvironment;

function unavailable(): Response {
  return Response.json(
    { error: { code: "RUNTIME_DISABLED", message: "Runtime request was rejected." } },
    {
      status: 503,
      headers: {
        "cache-control": "no-store",
        "content-security-policy": "default-src 'none'",
        "x-content-type-options": "nosniff",
      },
    },
  );
}

/**
 * Returns undefined only when the request is outside the Cloud Run runtime namespace.
 * The default production wiring deliberately supplies no service until Phase 14 cloud review.
 */
export async function handleCloudRunRuntimeShadowRequest(
  request: Request,
  environment: CloudRunRuntimeShadowEnvironment,
  service?: CloudRunRuntimeHttpService,
): Promise<Response | undefined> {
  const url = new URL(request.url);
  if (!url.pathname.startsWith(CLOUD_RUN_RUNTIME_PREFIX)) return undefined;
  if (parseCloudRunRuntimeShadowConfig(environment) === undefined) {
    return new Response(null, { status: 404 });
  }
  if (service === undefined) return unavailable();
  return handleCloudRunRuntimeRequest(request, service);
}
