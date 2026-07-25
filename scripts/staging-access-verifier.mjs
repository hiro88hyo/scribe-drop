const teamDomainPattern =
  /^https:\/\/[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.cloudflareaccess\.com$/u;
const redirectStatuses = new Set([301, 302, 303, 307, 308]);

function validateTeamDomain(teamDomain) {
  if (!teamDomainPattern.test(teamDomain)) {
    throw new Error(
      "SCRIBE_DROP_STAGING_ACCESS_TEAM_DOMAIN must be an exact https://<team>.cloudflareaccess.com origin",
    );
  }

  return new URL(teamDomain);
}

function validateWebOrigin(webOrigin) {
  try {
    const url = new URL(webOrigin);
    if (url.protocol !== "https:" || url.origin !== webOrigin) {
      throw new Error("invalid origin");
    }
    return url;
  } catch {
    throw new Error("SCRIBE_DROP_STAGING_WEB_ORIGIN must be an exact HTTPS origin");
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

export async function verifyStagingAccess(fetchImplementation, webOrigin, teamDomain) {
  const webUrl = validateWebOrigin(webOrigin);
  const teamUrl = validateTeamDomain(teamDomain);
  return Promise.all([
    verifyPath(fetchImplementation, webUrl, teamUrl, "/"),
    verifyPath(fetchImplementation, webUrl, teamUrl, "/api/me"),
  ]);
}
