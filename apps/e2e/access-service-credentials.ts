const ACCESS_CLIENT_ID_HEADER = "CF-Access-Client-Id";
const ACCESS_CLIENT_SECRET_HEADER = "CF-Access-Client-Secret";
const ACCESS_AUTHORIZATION_HEADER = "Authorization";
const ACCESS_CREDENTIAL_HEADER_NAMES = new Set([
  ACCESS_CLIENT_ID_HEADER.toLowerCase(),
  ACCESS_CLIENT_SECRET_HEADER.toLowerCase(),
  ACCESS_AUTHORIZATION_HEADER.toLowerCase(),
]);

function accessAuthorizationValue(credentials: AccessServiceCredentials): string {
  return JSON.stringify({
    "cf-access-client-id": credentials.clientId,
    "cf-access-client-secret": credentials.clientSecret,
  });
}

export interface AccessServiceCredentials {
  readonly clientId: string;
  readonly clientSecret: string;
}

export function headersForAccessRequest(
  requestUrl: string,
  appOrigin: string,
  requestHeaders: Readonly<Record<string, string>>,
  credentials: AccessServiceCredentials,
): Record<string, string> {
  const headers = Object.fromEntries(
    Object.entries(requestHeaders).filter(
      ([name]) => !ACCESS_CREDENTIAL_HEADER_NAMES.has(name.toLowerCase()),
    ),
  );
  if (new URL(requestUrl).origin === appOrigin) {
    headers[ACCESS_CLIENT_ID_HEADER] = credentials.clientId;
    headers[ACCESS_CLIENT_SECRET_HEADER] = credentials.clientSecret;
    headers[ACCESS_AUTHORIZATION_HEADER] = accessAuthorizationValue(credentials);
  }
  return headers;
}

export function serviceTokenCookieMatchesExpectedIdentity(
  token: string,
  expectedCommonName: string,
): boolean {
  const segments = token.split(".");
  const payloadSegment = segments[1];
  if (segments.length !== 3 || payloadSegment === undefined) {
    return false;
  }

  try {
    const payload = JSON.parse(
      Buffer.from(payloadSegment, "base64url").toString("utf8"),
    ) as unknown;
    return (
      typeof payload === "object" &&
      payload !== null &&
      "common_name" in payload &&
      payload.common_name === expectedCommonName &&
      "sub" in payload &&
      payload.sub === "" &&
      "type" in payload &&
      payload.type === "app"
    );
  } catch {
    return false;
  }
}
