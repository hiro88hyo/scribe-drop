const accountIdPattern = /^[0-9a-f]{32}$/u;
const projectNamePattern = /^[a-z0-9][a-z0-9-]{0,57}[a-z0-9]$/u;
const apiTokenPattern = /^[A-Za-z0-9_-]{20,256}$/u;

function requireIdentifier(value, pattern, name) {
  if (typeof value !== "string" || !pattern.test(value)) {
    throw new Error(`${name} is missing or invalid`);
  }
  return value;
}

export async function verifyPagesUploadPermission(
  fetchImplementation,
  { accountId: accountIdInput, apiToken: apiTokenInput, projectName: projectNameInput },
) {
  const accountId = requireIdentifier(accountIdInput, accountIdPattern, "CLOUDFLARE_ACCOUNT_ID");
  const apiToken = requireIdentifier(apiTokenInput, apiTokenPattern, "CLOUDFLARE_PAGES_API_TOKEN");
  const projectName = requireIdentifier(
    projectNameInput,
    projectNamePattern,
    "SCRIBE_DROP_STAGING_PAGES_PROJECT",
  );
  let response;
  try {
    response = await fetchImplementation(
      `https://api.cloudflare.com/client/v4/accounts/${accountId}/pages/projects/${encodeURIComponent(
        projectName,
      )}/upload-token`,
      {
        headers: {
          Accept: "application/json",
          Authorization: `Bearer ${apiToken}`,
        },
        method: "GET",
        redirect: "error",
        signal: AbortSignal.timeout(15_000),
      },
    );
  } catch {
    throw new Error("Cloudflare Pages upload permission request failed");
  }
  let envelope;
  try {
    envelope = await response.json();
  } catch {
    throw new Error("Cloudflare Pages upload permission response is invalid");
  }
  if (
    !response.ok ||
    typeof envelope !== "object" ||
    envelope === null ||
    envelope.success !== true ||
    !("result" in envelope) ||
    envelope.result === null ||
    envelope.result === undefined
  ) {
    throw new Error("Cloudflare Pages upload permission is not available");
  }
  return { verified: true };
}
