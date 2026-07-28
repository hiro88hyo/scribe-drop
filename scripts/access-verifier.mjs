const teamDomainPattern =
  /^https:\/\/[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.cloudflareaccess\.com$/u;
const redirectStatuses = new Set([301, 302, 303, 307, 308]);
const serviceClientIdPattern = /^[0-9a-f]{32}\.access$/u;
const serviceClientSecretPattern = /^[0-9a-f]{64}$/u;
const maximumAuthenticatedRedirects = 4;
const authenticatedVerificationTimeoutMs = 15_000;

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

function validateServiceCredentials(expectedCommonName, credentials) {
  if (
    !serviceClientIdPattern.test(expectedCommonName) ||
    typeof credentials !== "object" ||
    credentials === null ||
    credentials.clientId !== expectedCommonName ||
    !serviceClientIdPattern.test(credentials.clientId) ||
    !serviceClientSecretPattern.test(credentials.clientSecret)
  ) {
    throw new Error("Staging Access service credentials are invalid");
  }
  return {
    clientId: credentials.clientId,
    clientSecret: credentials.clientSecret,
  };
}

function accessCookieFromResponse(response) {
  const setCookies =
    typeof response.headers.getSetCookie === "function"
      ? response.headers.getSetCookie()
      : [response.headers.get("set-cookie")].filter((value) => typeof value === "string");
  for (const setCookie of setCookies) {
    const match = /(?:^|,\s*)CF_Authorization=([^;,]+)/u.exec(setCookie);
    if (match?.[1] !== undefined) {
      return match[1];
    }
  }
  return null;
}

function serviceTokenCookieMatchesExpectedIdentity(token, expectedCommonName) {
  const segments = token.split(".");
  const payloadSegment = segments[1];
  if (segments.length !== 3 || payloadSegment === undefined) {
    return false;
  }

  try {
    const payload = JSON.parse(Buffer.from(payloadSegment, "base64url").toString("utf8"));
    return (
      typeof payload === "object" &&
      payload !== null &&
      payload.common_name === expectedCommonName &&
      payload.sub === "" &&
      payload.type === "app"
    );
  } catch {
    return false;
  }
}

function serviceAuthenticationHeaders(credentials, cookie) {
  return {
    Accept: "text/html,application/json",
    Authorization: JSON.stringify({
      "cf-access-client-id": credentials.clientId,
      "cf-access-client-secret": credentials.clientSecret,
    }),
    "CF-Access-Client-Id": credentials.clientId,
    "CF-Access-Client-Secret": credentials.clientSecret,
    ...(cookie === null ? {} : { Cookie: `CF_Authorization=${cookie}` }),
    "User-Agent": "ScribeDrop-Access-Service-Preflight/1.0",
  };
}

function isApiBoundaryResponse(headers) {
  const contentType = headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  const cacheControl = headers
    .get("cache-control")
    ?.split(",")
    .map((directive) => directive.trim().toLowerCase());
  return (
    contentType === "application/json" &&
    cacheControl?.includes("no-store") === true &&
    headers.get("x-content-type-options")?.toLowerCase() === "nosniff"
  );
}

async function requestAuthenticatedPath(
  fetchImplementation,
  webUrl,
  teamUrl,
  path,
  credentials,
  expectedCommonName,
  initialCookie,
  signal,
) {
  let cookie = initialCookie;
  let requestUrl = new URL(path, webUrl.origin);

  for (let redirectCount = 0; redirectCount <= maximumAuthenticatedRedirects; redirectCount += 1) {
    let response;
    try {
      response = await fetchImplementation(requestUrl.href, {
        headers: serviceAuthenticationHeaders(credentials, cookie),
        redirect: "manual",
        signal,
      });
    } catch {
      throw new Error(`${path} staging Access service request failed`);
    }

    const issuedCookie = accessCookieFromResponse(response);
    if (issuedCookie !== null) {
      cookie = issuedCookie;
    }
    if (redirectStatuses.has(response.status)) {
      const location = response.headers.get("location");
      if (location === null) {
        throw new Error(`${path} staging Access redirect is missing Location`);
      }
      const redirectUrl = new URL(location, requestUrl);
      if (
        redirectUrl.origin === teamUrl.origin &&
        redirectUrl.pathname.startsWith("/cdn-cgi/access/login/")
      ) {
        throw new Error(`${path} staging Access authentication was not accepted`);
      }
      if (redirectUrl.origin !== webUrl.origin) {
        throw new Error(`${path} staging Access redirected outside the exact staging origin`);
      }
      requestUrl = redirectUrl;
      continue;
    }

    if (!response.ok) {
      throw new Error(
        `${path} staging Access service request failed with status ${response.status}`,
      );
    }
    if (cookie === null || !serviceTokenCookieMatchesExpectedIdentity(cookie, expectedCommonName)) {
      throw new Error(`${path} staging Access did not issue the expected service principal cookie`);
    }
    if (path === "/api/me" && !isApiBoundaryResponse(response.headers)) {
      throw new Error(`${path} staging Access did not reach the authenticated API boundary`);
    }
    return {
      cookie,
      result: {
        path,
        status: response.status,
      },
    };
  }

  throw new Error(`${path} staging Access exceeded the authenticated redirect limit`);
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

export async function verifyStagingServiceToken(
  fetchImplementation,
  webOrigin,
  teamDomain,
  expectedCommonName,
  credentials,
) {
  const webUrl = validateWebOrigin(webOrigin, "staging");
  const teamUrl = validateTeamDomain(teamDomain, "staging");
  const validatedCredentials = validateServiceCredentials(expectedCommonName, credentials);
  const signal = AbortSignal.timeout(authenticatedVerificationTimeoutMs);
  const root = await requestAuthenticatedPath(
    fetchImplementation,
    webUrl,
    teamUrl,
    "/",
    validatedCredentials,
    expectedCommonName,
    null,
    signal,
  );
  const api = await requestAuthenticatedPath(
    fetchImplementation,
    webUrl,
    teamUrl,
    "/api/me",
    validatedCredentials,
    expectedCommonName,
    root.cookie,
    signal,
  );
  return [root.result, api.result];
}
