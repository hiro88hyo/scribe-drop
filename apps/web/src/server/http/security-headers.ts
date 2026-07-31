export const API_CONTENT_SECURITY_POLICY =
  "default-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

const API_SECURITY_HEADERS = [
  ["Cache-Control", "no-store"],
  ["Content-Security-Policy", API_CONTENT_SECURITY_POLICY],
  ["Cross-Origin-Resource-Policy", "same-origin"],
  [
    "Permissions-Policy",
    "accelerometer=(), camera=(), display-capture=(), document-domain=(), geolocation=(), gyroscope=(), magnetometer=(), microphone=(), payment=(), usb=()",
  ],
  ["Referrer-Policy", "no-referrer"],
  ["X-Content-Type-Options", "nosniff"],
  ["X-Frame-Options", "DENY"],
  ["X-Robots-Tag", "noindex, nofollow"],
] as const;

const CORS_RESPONSE_HEADERS = [
  "Access-Control-Allow-Credentials",
  "Access-Control-Allow-Headers",
  "Access-Control-Allow-Methods",
  "Access-Control-Allow-Origin",
  "Access-Control-Expose-Headers",
] as const;

export function applyApiSecurityHeaders(response: Response, requestId: string): Response {
  const headers = new Headers(response.headers);

  for (const [name, value] of API_SECURITY_HEADERS) {
    headers.set(name, value);
  }
  for (const name of CORS_RESPONSE_HEADERS) {
    headers.delete(name);
  }
  headers.set("X-Request-ID", requestId);

  return new Response(response.body, {
    headers,
    status: response.status,
    statusText: response.statusText,
  });
}
