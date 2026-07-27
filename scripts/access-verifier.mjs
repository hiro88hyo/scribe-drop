const teamDomainPattern =
  /^https:\/\/[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.cloudflareaccess\.com$/u;
const redirectStatuses = new Set([301, 302, 303, 307, 308]);

function validateEnvironment(environment) {
  if (environment !== "staging" && environment !== "production") {
    throw new Error("Access environment must be staging or production");
  }
  return environment;
}

function rejectMixedEnvironment(value, environment, name) {
  const forbidden = environment === "production" ? "staging" : "production";
  if (value.toLowerCase().includes(forbidden)) {
    throw new Error(`${name} must not contain a ${forbidden} environment marker`);
  }
}

function validateTeamDomain(teamDomain, environment) {
  const prefix = `SCRIBE_DROP_${environment.toUpperCase()}_ACCESS_TEAM_DOMAIN`;
  if (!teamDomainPattern.test(teamDomain)) {
    throw new Error(`${prefix} must be an exact https://<team>.cloudflareaccess.com origin`);
  }
  rejectMixedEnvironment(teamDomain, environment, prefix);

  return new URL(teamDomain);
}

function validateWebOrigin(webOrigin, environment) {
  const prefix = `SCRIBE_DROP_${environment.toUpperCase()}_WEB_ORIGIN`;
  try {
    const url = new URL(webOrigin);
    if (url.protocol !== "https:" || url.origin !== webOrigin) {
      throw new Error("invalid origin");
    }
    rejectMixedEnvironment(webOrigin, environment, prefix);
    return url;
  } catch {
    throw new Error(`${prefix} must be an exact HTTPS origin without mixed environment markers`);
  }
}

async function verifyPath(fetchImplementation, webUrl, teamUrl, path) {
  const response = await fetchImplementation(`${webUrl.origin}${path}`, {
    headers: {
      Accept: "text/html,application/json",
      "User-Agent": "ScribeDrop-Access-Preflight/1.0",
    },
    redirect: "manual",
  });

  if (!redirectStatuses.has(response.status)) {
    throw new Error(
      `${path} is not protected by an Access login redirect (status ${response.status})`,
    );
  }

  const location = response.headers.get("location");
  if (location === null) {
    throw new Error(`${path} Access redirect is missing Location`);
  }

  const redirectUrl = new URL(location, webUrl.origin);
  if (
    redirectUrl.origin !== teamUrl.origin ||
    !redirectUrl.pathname.startsWith("/cdn-cgi/access/login/")
  ) {
    throw new Error(`${path} redirected outside the expected Access login boundary`);
  }

  return {
    path,
    status: response.status,
  };
}

export async function verifyAccess(fetchImplementation, environment, webOrigin, teamDomain) {
  const validatedEnvironment = validateEnvironment(environment);
  const webUrl = validateWebOrigin(webOrigin, validatedEnvironment);
  const teamUrl = validateTeamDomain(teamDomain, validatedEnvironment);
  return Promise.all([
    verifyPath(fetchImplementation, webUrl, teamUrl, "/"),
    verifyPath(fetchImplementation, webUrl, teamUrl, "/api/me"),
  ]);
}

export function verifyStagingAccess(fetchImplementation, webOrigin, teamDomain) {
  return verifyAccess(fetchImplementation, "staging", webOrigin, teamDomain);
}

export function verifyProductionAccess(fetchImplementation, webOrigin, teamDomain) {
  return verifyAccess(fetchImplementation, "production", webOrigin, teamDomain);
}
