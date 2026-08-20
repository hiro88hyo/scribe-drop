const expectedBaseDigest =
  "sha256:b1386d556b478c420927eb212236bfb31be9834a4549850a060a6351f7fff514";

function requireObject(value, name) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${name} is invalid`);
  }
  return value;
}

export function verifyGpuControllerImageInspection(value) {
  if (!Array.isArray(value) || value.length !== 1) {
    throw new Error("GPU controller image inspection must contain one image");
  }
  const image = requireObject(value[0], "GPU controller image");
  const configuration = requireObject(image.Config, "GPU controller image configuration");
  const labels = requireObject(configuration.Labels, "GPU controller image labels");
  const exposedPorts = requireObject(configuration.ExposedPorts, "GPU controller exposed ports");
  if (image.Architecture !== "amd64" || image.Os !== "linux") {
    throw new Error("GPU controller image platform drifted");
  }
  if (typeof image.Size !== "number" || image.Size <= 0 || image.Size > 300_000_000) {
    throw new Error("GPU controller image size is invalid");
  }
  if (configuration.User !== "10001:10001" || configuration.WorkingDir !== "/app") {
    throw new Error("GPU controller runtime identity drifted");
  }
  if (
    !Array.isArray(configuration.Entrypoint) ||
    configuration.Entrypoint.length !== 2 ||
    configuration.Entrypoint[0] !== "/nodejs/bin/node" ||
    configuration.Entrypoint[1] !== "dist/entrypoint.js" ||
    (configuration.Cmd !== undefined && configuration.Cmd !== null)
  ) {
    throw new Error("GPU controller entrypoint drifted");
  }
  if (
    !Array.isArray(configuration.Env) ||
    !configuration.Env.includes("HOME=/nonexistent") ||
    !configuration.Env.includes("NODE_ENV=production") ||
    !configuration.Env.includes("PORT=8080") ||
    configuration.Env.some(
      (entry) =>
        typeof entry !== "string" ||
        entry.startsWith("SCRIBE_DROP_CONTROLLER_HMAC_") ||
        entry.startsWith("GOOGLE_APPLICATION_CREDENTIALS="),
    )
  ) {
    throw new Error("GPU controller image environment drifted");
  }
  if (
    labels["org.opencontainers.image.title"] !== "ScribeDrop GPU Controller" ||
    labels["org.opencontainers.image.base.name"] !==
      "gcr.io/distroless/nodejs24-debian13:nonroot" ||
    labels["org.opencontainers.image.base.digest"] !== expectedBaseDigest ||
    labels["io.scribedrop.node.version"] !== "24.18.0" ||
    labels["io.scribedrop.controller.policy"] !== "cloud_run_jobs_l4_v1"
  ) {
    throw new Error("GPU controller image labels drifted");
  }
  if (
    Object.keys(exposedPorts).length !== 1 ||
    !Object.hasOwn(exposedPorts, "8080/tcp") ||
    (configuration.Volumes !== null && configuration.Volumes !== undefined)
  ) {
    throw new Error("GPU controller image port or volume drifted");
  }
}
