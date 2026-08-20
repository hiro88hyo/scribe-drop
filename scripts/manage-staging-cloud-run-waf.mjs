import process from "node:process";

import {
  createStagingCloudRunWafRule,
  findStagingCloudRunWafRule,
  parseStagingCloudRunWafTarget,
  verifyStagingCloudRunWafRule,
} from "./cloud-run-waf-rule.mjs";

const operation = process.argv[2];
if (!new Set(["apply", "read", "remove"]).has(operation)) {
  throw new Error("Usage: manage-staging-cloud-run-waf <apply|read|remove>");
}
const token = process.env.CLOUDFLARE_WAF_API_TOKEN;
if (typeof token !== "string" || !/^[A-Za-z0-9_-]{20,256}$/u.test(token)) {
  throw new Error("CLOUDFLARE_WAF_API_TOKEN is missing or invalid");
}
const orchestratorOrigin = process.env.SCRIBE_DROP_STAGING_ORCHESTRATOR_ORIGIN;
const zoneName = process.env.CLOUDFLARE_ZONE_NAME;
const target = parseStagingCloudRunWafTarget(orchestratorOrigin, zoneName);
const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };

async function api(path, init = {}) {
  const response = await fetch(`https://api.cloudflare.com/client/v4${path}`, {
    ...init,
    headers: { ...headers, ...init.headers },
    redirect: "error",
    signal: AbortSignal.timeout(15_000),
  });
  let body;
  try {
    body = await response.json();
  } catch {
    throw new Error("Cloudflare WAF response was invalid");
  }
  if (!response.ok || body?.success !== true) {
    throw new Error(`Cloudflare WAF request failed: ${response.status}`);
  }
  return body.result;
}

const zones = await api(
  `/zones?name=${encodeURIComponent(target.zoneName)}&status=active&per_page=5`,
  { headers: { accept: "application/json" } },
);
if (!Array.isArray(zones) || zones.length !== 1 || !/^[a-f0-9]{32}$/u.test(zones[0]?.id)) {
  throw new Error("Cloudflare staging zone is not unique");
}
const zoneId = zones[0].id;
const entrypointPath = `/zones/${zoneId}/rulesets/phases/http_request_firewall_custom/entrypoint`;

async function readEntrypoint() {
  const response = await fetch(`https://api.cloudflare.com/client/v4${entrypointPath}`, {
    headers,
    redirect: "error",
    signal: AbortSignal.timeout(15_000),
  });
  if (response.status === 404) {
    await response.body?.cancel();
    return null;
  }
  let body;
  try {
    body = await response.json();
  } catch {
    throw new Error("Cloudflare custom ruleset response was invalid");
  }
  if (!response.ok || body?.success !== true) {
    throw new Error(`Cloudflare custom ruleset read failed: ${response.status}`);
  }
  return body.result;
}

function requireResourceId(value, label) {
  if (typeof value !== "string" || !/^[a-f0-9]{32}$/u.test(value)) {
    throw new Error(`${label} identity is invalid`);
  }
  return value;
}

async function readExactTwice() {
  const first = await readEntrypoint();
  const second = await readEntrypoint();
  if (first === null || second === null) throw new Error("Cloud Run BIC exception is missing");
  const left = verifyStagingCloudRunWafRule(first, orchestratorOrigin);
  const right = verifyStagingCloudRunWafRule(second, orchestratorOrigin);
  if (JSON.stringify(left) !== JSON.stringify(right)) {
    throw new Error("Cloud Run BIC exception changed during read-back");
  }
  return right;
}

if (operation === "read") {
  const entrypoint = await readEntrypoint();
  if (entrypoint === null || findStagingCloudRunWafRule(entrypoint) === null) {
    console.log(JSON.stringify({ present: false }));
  } else {
    console.log(
      JSON.stringify({
        present: true,
        ...verifyStagingCloudRunWafRule(entrypoint, orchestratorOrigin),
      }),
    );
  }
} else if (operation === "apply") {
  const desired = createStagingCloudRunWafRule(orchestratorOrigin);
  const entrypoint = await readEntrypoint();
  let outcome = "unchanged";
  if (entrypoint === null) {
    await api(`/zones/${zoneId}/rulesets`, {
      method: "POST",
      body: JSON.stringify({
        description: "ScribeDrop staging zone custom rules",
        kind: "zone",
        name: "ScribeDrop staging zone custom rules",
        phase: "http_request_firewall_custom",
        rules: [desired],
      }),
    });
    outcome = "created-entrypoint";
  } else {
    const rulesetId = requireResourceId(entrypoint.id, "custom ruleset");
    const existing = findStagingCloudRunWafRule(entrypoint);
    if (existing === null) {
      await api(`/zones/${zoneId}/rulesets/${rulesetId}/rules`, {
        method: "POST",
        body: JSON.stringify(desired),
      });
      outcome = "created-rule";
    } else {
      try {
        verifyStagingCloudRunWafRule(entrypoint, orchestratorOrigin);
      } catch {
        const ruleId = requireResourceId(existing.id, "Cloud Run BIC rule");
        await api(`/zones/${zoneId}/rulesets/${rulesetId}/rules/${ruleId}`, {
          method: "PATCH",
          body: JSON.stringify(desired),
        });
        outcome = "updated-rule";
      }
    }
  }
  console.log(JSON.stringify({ outcome, ...(await readExactTwice()) }));
} else {
  const entrypoint = await readEntrypoint();
  const existing = entrypoint === null ? null : findStagingCloudRunWafRule(entrypoint);
  if (entrypoint !== null && existing !== null) {
    verifyStagingCloudRunWafRule(entrypoint, orchestratorOrigin);
    const rulesetId = requireResourceId(entrypoint.id, "custom ruleset");
    const ruleId = requireResourceId(existing.id, "Cloud Run BIC rule");
    await api(`/zones/${zoneId}/rulesets/${rulesetId}/rules/${ruleId}`, { method: "DELETE" });
  }
  const after = await readEntrypoint();
  if (after !== null && findStagingCloudRunWafRule(after) !== null) {
    throw new Error("Cloud Run BIC exception removal did not converge");
  }
  console.log(JSON.stringify({ present: false, removed: existing !== null }));
}
