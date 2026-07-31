import process from "node:process";

const accountIdPattern = /^[0-9a-f]{32}$/u;
const accessAudiencePattern = /^[A-Za-z0-9_-]{1,256}$/u;
const serviceTokenCommonNamePattern = /^[0-9a-f]{32}\.access$/u;

function requireIdentifier(value, pattern, name) {
  if (typeof value !== "string" || !pattern.test(value)) {
    throw new Error(`${name} is missing or invalid`);
  }
  return value;
}

function referencesOnlyServiceToken(policy, tokenId) {
  return (
    policy?.decision === "non_identity" &&
    Array.isArray(policy.include) &&
    policy.include.length === 1 &&
    policy.include[0]?.service_token?.token_id === tokenId &&
    (!Array.isArray(policy.require) || policy.require.length === 0) &&
    (!Array.isArray(policy.exclude) || policy.exclude.length === 0)
  );
}

function requireSingleMatch(values, predicate, message) {
  const matches = values.filter(predicate);
  if (matches.length !== 1) {
    throw new Error(message);
  }
  return matches[0];
}

function verifyApplication(application, tokenId, expectedHeader, label) {
  if (
    typeof application !== "object" ||
    application === null ||
    application.type !== "self_hosted" ||
    !Array.isArray(application.policies)
  ) {
    throw new Error(`Staging ${label} Access application is invalid`);
  }
  const configuredHeader = application.read_service_tokens_from_header;
  if (
    (expectedHeader === null && configuredHeader !== undefined && configuredHeader !== null) ||
    (expectedHeader !== null && configuredHeader !== expectedHeader)
  ) {
    throw new Error(`Staging ${label} Access service-token header configuration does not match`);
  }
  const serviceAuthPolicies = application.policies.filter(
    (policy) => policy?.decision === "non_identity",
  );
  if (
    serviceAuthPolicies.length !== 1 ||
    !referencesOnlyServiceToken(serviceAuthPolicies[0], tokenId)
  ) {
    throw new Error(`Staging ${label} Access Service Auth policy is not exact`);
  }
}

export function verifyStagingAccessControlPlane(inventory, expected) {
  if (
    typeof inventory !== "object" ||
    inventory === null ||
    !Array.isArray(inventory.applications) ||
    !Array.isArray(inventory.serviceTokens)
  ) {
    throw new Error("Staging Access control-plane inventory is invalid");
  }
  const customAudience = requireIdentifier(
    expected.customAudience,
    accessAudiencePattern,
    "SCRIBE_DROP_STAGING_ACCESS_AUDIENCE",
  );
  const pagesAudience = requireIdentifier(
    expected.pagesAudience,
    accessAudiencePattern,
    "SCRIBE_DROP_STAGING_PAGES_ACCESS_AUDIENCE",
  );
  if (customAudience === pagesAudience) {
    throw new Error("Staging Access audiences must be distinct");
  }
  const serviceTokenCommonName = requireIdentifier(
    expected.serviceTokenCommonName,
    serviceTokenCommonNamePattern,
    "SCRIBE_DROP_STAGING_E2E_SERVICE_TOKEN_COMMON_NAME",
  );
  const serviceToken = requireSingleMatch(
    inventory.serviceTokens,
    (token) => token?.client_id === serviceTokenCommonName && typeof token?.id === "string",
    "Staging Access service token is missing or ambiguous",
  );
  const customApplication = requireSingleMatch(
    inventory.applications,
    (application) => application?.aud === customAudience,
    "Staging custom-domain Access application is missing or ambiguous",
  );
  const pagesApplication = requireSingleMatch(
    inventory.applications,
    (application) => application?.aud === pagesAudience,
    "Staging Pages Access application is missing or ambiguous",
  );
  if (
    typeof customApplication.id !== "string" ||
    typeof pagesApplication.id !== "string" ||
    customApplication.id === pagesApplication.id
  ) {
    throw new Error("Staging Access application identities are invalid");
  }

  verifyApplication(customApplication, serviceToken.id, null, "custom-domain");
  verifyApplication(pagesApplication, serviceToken.id, "Authorization", "Pages");
  return {
    applications: 2,
    serviceAuthPolicies: 2,
  };
}

async function cloudflareGet(accountId, apiToken, resource) {
  const response = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${accountId}/access/${resource}?per_page=100`,
    {
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${apiToken}`,
      },
      redirect: "error",
      signal: AbortSignal.timeout(15_000),
    },
  );
  let envelope;
  try {
    envelope = await response.json();
  } catch {
    throw new Error("Cloudflare Access control-plane response is invalid");
  }
  if (!response.ok || envelope?.success !== true || !Array.isArray(envelope.result)) {
    throw new Error("Cloudflare Access control-plane read-back failed");
  }
  return envelope.result;
}

export async function readAndVerifyStagingAccessControlPlane(environment = process.env) {
  const accountId = requireIdentifier(
    environment.CLOUDFLARE_ACCOUNT_ID,
    accountIdPattern,
    "CLOUDFLARE_ACCOUNT_ID",
  );
  const apiToken = requireIdentifier(
    environment.CLOUDFLARE_API_TOKEN,
    /^[A-Za-z0-9_-]{20,256}$/u,
    "CLOUDFLARE_API_TOKEN",
  );
  const [applications, serviceTokens] = await Promise.all([
    cloudflareGet(accountId, apiToken, "apps"),
    cloudflareGet(accountId, apiToken, "service_tokens"),
  ]);
  return verifyStagingAccessControlPlane(
    { applications, serviceTokens },
    {
      customAudience: environment.SCRIBE_DROP_STAGING_ACCESS_AUDIENCE,
      pagesAudience: environment.SCRIBE_DROP_STAGING_PAGES_ACCESS_AUDIENCE,
      serviceTokenCommonName: environment.SCRIBE_DROP_STAGING_E2E_SERVICE_TOKEN_COMMON_NAME,
    },
  );
}
