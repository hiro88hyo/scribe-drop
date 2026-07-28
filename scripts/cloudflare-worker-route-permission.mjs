const accountIdPattern = /^[0-9a-f]{32}$/u;
const apiTokenPattern = /^[A-Za-z0-9_-]{20,256}$/u;

function requireCloudflareResult(envelope, name) {
  if (
    typeof envelope !== "object" ||
    envelope === null ||
    envelope.success !== true ||
    !Array.isArray(envelope.result)
  ) {
    throw new Error(`Cloudflare ${name} capability response is invalid`);
  }
  return envelope.result;
}

async function fetchCloudflareList(pathname, searchParams, apiToken, fetchImplementation, name) {
  const url = new URL(`https://api.cloudflare.com/client/v4${pathname}`);
  for (const [key, value] of Object.entries(searchParams)) {
    url.searchParams.set(key, value);
  }
  const response = await fetchImplementation(url, {
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${apiToken}`,
    },
    redirect: "error",
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) {
    throw new Error(`Cloudflare ${name} capability is unavailable`);
  }
  return requireCloudflareResult(await response.json(), name);
}

function requireExactOrigin(value) {
  if (typeof value !== "string") {
    throw new Error("Orchestrator origin is missing or invalid");
  }
  try {
    const url = new URL(value);
    if (
      url.protocol !== "https:" ||
      url.origin !== value ||
      url.port !== "" ||
      url.username !== "" ||
      url.password !== ""
    ) {
      throw new Error("invalid origin");
    }
    return url;
  } catch {
    throw new Error("Orchestrator origin is missing or invalid");
  }
}

export async function verifyCloudflareWorkerRoutePermission(input, fetchImplementation = fetch) {
  if (
    typeof input !== "object" ||
    input === null ||
    typeof input.accountId !== "string" ||
    !accountIdPattern.test(input.accountId) ||
    typeof input.apiToken !== "string" ||
    !apiTokenPattern.test(input.apiToken) ||
    typeof fetchImplementation !== "function"
  ) {
    throw new Error("Cloudflare Worker route capability input is invalid");
  }
  const origin = requireExactOrigin(input.orchestratorOrigin);
  const labels = origin.hostname.split(".");
  let zone;
  for (let offset = 0; offset < labels.length - 1; offset += 1) {
    const zoneName = labels.slice(offset).join(".");
    const zones = await fetchCloudflareList(
      "/zones",
      { "account.id": input.accountId, name: zoneName },
      input.apiToken,
      fetchImplementation,
      "Zone Read",
    );
    const matches = zones.filter(
      (candidate) =>
        candidate?.name === zoneName &&
        candidate?.status === "active" &&
        candidate?.account?.id === input.accountId &&
        typeof candidate?.id === "string" &&
        accountIdPattern.test(candidate.id),
    );
    if (matches.length > 1) {
      throw new Error("Cloudflare active application zone is ambiguous");
    }
    if (matches.length === 1) {
      zone = matches[0];
      break;
    }
  }
  if (zone === undefined) {
    throw new Error("Cloudflare active application zone was not found");
  }

  await fetchCloudflareList(
    `/zones/${zone.id}/workers/routes`,
    {},
    input.apiToken,
    fetchImplementation,
    "Workers Routes Read",
  );
}
