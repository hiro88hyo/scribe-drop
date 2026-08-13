export const STAGING_CLOUD_RUN_WAF_DESCRIPTION =
  "ScribeDrop staging Cloud Run runtime: skip BIC only";

export function parseStagingCloudRunWafHostname(orchestratorOrigin) {
  if (typeof orchestratorOrigin !== "string") {
    throw new Error("staging Orchestrator origin is invalid");
  }
  try {
    const url = new URL(orchestratorOrigin);
    const isStagingHostname = url.hostname
      .split(".")
      .some(
        (label) =>
          label === "staging" || label.startsWith("staging-") || label.endsWith("-staging"),
      );
    if (
      url.protocol !== "https:" ||
      url.origin !== orchestratorOrigin ||
      url.port !== "" ||
      url.username !== "" ||
      url.password !== "" ||
      !isStagingHostname ||
      url.hostname.includes("production")
    ) {
      throw new Error("invalid origin");
    }
    return url.hostname;
  } catch {
    throw new Error("staging Orchestrator origin is invalid");
  }
}

export function parseStagingCloudRunWafTarget(orchestratorOrigin, zoneName) {
  const hostname = parseStagingCloudRunWafHostname(orchestratorOrigin);
  if (
    typeof zoneName !== "string" ||
    zoneName !== zoneName.toLowerCase() ||
    zoneName.endsWith(".invalid") ||
    zoneName.includes("production") ||
    !/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/u.test(zoneName) ||
    (hostname !== zoneName && !hostname.endsWith(`.${zoneName}`))
  ) {
    throw new Error("staging Cloudflare zone is invalid");
  }
  return { hostname, zoneName };
}

export function createStagingCloudRunWafExpression(orchestratorOrigin) {
  const hostname = parseStagingCloudRunWafHostname(orchestratorOrigin);
  return (
    `http.host eq ${JSON.stringify(hostname)} and http.request.method eq "POST" and ` +
    'http.request.uri.query eq "" and http.request.uri.path in {' +
    '"/internal/cloud-run/ack" "/internal/cloud-run/bootstrap" ' +
    '"/internal/cloud-run/claim" "/internal/cloud-run/heartbeat" ' +
    '"/internal/cloud-run/terminal"}'
  );
}

export function createStagingCloudRunWafRule(orchestratorOrigin) {
  return {
    action: "skip",
    action_parameters: { products: ["bic"] },
    description: STAGING_CLOUD_RUN_WAF_DESCRIPTION,
    enabled: true,
    expression: createStagingCloudRunWafExpression(orchestratorOrigin),
    logging: { enabled: true },
  };
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (isRecord(value)) {
    return `{${Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function relatedRules(entrypoint) {
  if (
    !isRecord(entrypoint) ||
    entrypoint.kind !== "zone" ||
    entrypoint.phase !== "http_request_firewall_custom" ||
    !Array.isArray(entrypoint.rules)
  ) {
    throw new Error("Cloudflare custom ruleset entrypoint is invalid");
  }
  return entrypoint.rules.filter(
    (rule) =>
      isRecord(rule) &&
      (rule.description === STAGING_CLOUD_RUN_WAF_DESCRIPTION ||
        (typeof rule.expression === "string" && rule.expression.includes("/internal/cloud-run/"))),
  );
}

export function findStagingCloudRunWafRule(entrypoint) {
  const related = relatedRules(entrypoint);
  if (related.length > 1) {
    throw new Error("Cloud Run BIC exception is duplicate or ambiguous");
  }
  return related[0] ?? null;
}

export function verifyStagingCloudRunWafRule(entrypoint, orchestratorOrigin) {
  const rule = findStagingCloudRunWafRule(entrypoint);
  if (rule === null) throw new Error("Cloud Run BIC exception is missing");
  const observed = {
    action: rule.action,
    action_parameters: rule.action_parameters,
    description: rule.description,
    enabled: rule.enabled ?? true,
    expression: rule.expression,
    logging: rule.logging,
  };
  if (canonical(observed) !== canonical(createStagingCloudRunWafRule(orchestratorOrigin))) {
    throw new Error("Cloud Run BIC exception drifted");
  }
  return {
    exactHost: true,
    exactPaths: 5,
    logged: true,
    skippedProducts: ["bic"],
  };
}
