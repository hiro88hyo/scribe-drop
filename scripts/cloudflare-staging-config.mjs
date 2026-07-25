const accountIdPattern = /^[0-9a-f]{32}$/u;
const accessAudiencePattern = /^[A-Za-z0-9_-]{1,256}$/u;
const accessTeamDomainPattern =
  /^https:\/\/[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.cloudflareaccess\.com$/u;
const d1DatabaseIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;

const accountIdPlaceholder = "0".repeat(32);
const accessAudiencePlaceholder = "replace-with-access-audience";
const accessTeamDomainPlaceholder = "https://replace-with-team.cloudflareaccess.com";
const stagingD1DatabaseIdPlaceholder = "00000000-0000-0000-0000-000000000101";
const webOriginPlaceholder = "https://replace-with-staging-web.example.invalid";

function requireIdentifier(value, pattern, name) {
  if (typeof value !== "string" || !pattern.test(value)) {
    throw new Error(`${name} is missing or has an invalid format`);
  }

  return value;
}

function replaceOnce(source, searchValue, replacement, label) {
  const firstIndex = source.indexOf(searchValue);
  if (firstIndex === -1) {
    throw new Error(`${label} placeholder was not found`);
  }

  if (source.indexOf(searchValue, firstIndex + searchValue.length) !== -1) {
    throw new Error(`${label} placeholder is ambiguous`);
  }

  return `${source.slice(0, firstIndex)}${replacement}${source.slice(
    firstIndex + searchValue.length,
  )}`;
}

function requireExactHttpsOrigin(value) {
  if (typeof value !== "string") {
    throw new Error("SCRIBE_DROP_STAGING_WEB_ORIGIN is missing or invalid");
  }

  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.origin !== value) {
      throw new Error("invalid origin");
    }
  } catch {
    throw new Error("SCRIBE_DROP_STAGING_WEB_ORIGIN is missing or invalid");
  }

  return value;
}

function validatedResourceIdentifiers(identifiers) {
  return {
    accountId: requireIdentifier(identifiers.accountId, accountIdPattern, "CLOUDFLARE_ACCOUNT_ID"),
    d1DatabaseId: requireIdentifier(
      identifiers.d1DatabaseId,
      d1DatabaseIdPattern,
      "SCRIBE_DROP_STAGING_D1_DATABASE_ID",
    ),
  };
}

export function renderOrchestratorStagingConfig(template, identifiers) {
  const { accountId, d1DatabaseId } = validatedResourceIdentifiers(identifiers);
  const stagingMarker = "[env.staging]";
  const stagingIndex = template.indexOf(stagingMarker);
  if (stagingIndex === -1) {
    throw new Error("orchestrator staging environment was not found");
  }

  const baseConfig = template.slice(0, stagingIndex);
  let stagingConfig = template.slice(stagingIndex);
  stagingConfig = replaceOnce(
    stagingConfig,
    `CLOUDFLARE_ACCOUNT_ID = "${accountIdPlaceholder}"`,
    `CLOUDFLARE_ACCOUNT_ID = "${accountId}"`,
    "orchestrator staging account ID",
  );
  stagingConfig = replaceOnce(
    stagingConfig,
    `database_id = "${stagingD1DatabaseIdPlaceholder}"`,
    `database_id = "${d1DatabaseId}"`,
    "orchestrator staging D1 database ID",
  );

  return replaceOnce(
    `${baseConfig}${stagingConfig}`,
    'main = "src/index.ts"',
    'main = "../../apps/orchestrator/src/index.ts"',
    "orchestrator entrypoint",
  );
}

export function renderWebStagingConfig(template, identifiers) {
  const { accountId, d1DatabaseId } = validatedResourceIdentifiers(identifiers);
  const accessAudience = requireIdentifier(
    identifiers.accessAudience,
    accessAudiencePattern,
    "SCRIBE_DROP_STAGING_ACCESS_AUDIENCE",
  );
  const accessTeamDomain = requireIdentifier(
    identifiers.accessTeamDomain,
    accessTeamDomainPattern,
    "SCRIBE_DROP_STAGING_ACCESS_TEAM_DOMAIN",
  );
  const webOrigin = requireExactHttpsOrigin(identifiers.webOrigin);
  let rendered = replaceOnce(
    template,
    `CLOUDFLARE_ACCOUNT_ID = "${accountIdPlaceholder}"`,
    `CLOUDFLARE_ACCOUNT_ID = "${accountId}"`,
    "web staging account ID",
  );
  rendered = replaceOnce(
    rendered,
    `database_id = "${stagingD1DatabaseIdPlaceholder}"`,
    `database_id = "${d1DatabaseId}"`,
    "web staging D1 database ID",
  );
  rendered = replaceOnce(
    rendered,
    `ACCESS_TEAM_DOMAIN = "${accessTeamDomainPlaceholder}"`,
    `ACCESS_TEAM_DOMAIN = "${accessTeamDomain}"`,
    "web staging Access team domain",
  );
  rendered = replaceOnce(
    rendered,
    `ACCESS_AUDIENCES = ${JSON.stringify(JSON.stringify([accessAudiencePlaceholder]))}`,
    `ACCESS_AUDIENCES = ${JSON.stringify(JSON.stringify([accessAudience]))}`,
    "web staging Access audience",
  );
  rendered = replaceOnce(
    rendered,
    `ALLOWED_ORIGIN = "${webOriginPlaceholder}"`,
    `ALLOWED_ORIGIN = "${webOrigin}"`,
    "web staging origin",
  );

  return replaceOnce(
    rendered,
    'pages_build_output_dir = "./dist"',
    'pages_build_output_dir = "../../dist"',
    "web build output directory",
  );
}

export function renderR2CorsStagingConfig(template, identifiers) {
  const webOrigin = requireExactHttpsOrigin(identifiers.webOrigin);
  return replaceOnce(
    template,
    `"origins": ["${webOriginPlaceholder}"]`,
    `"origins": ["${webOrigin}"]`,
    "R2 CORS staging origin",
  );
}
