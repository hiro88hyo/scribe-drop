import assert from "node:assert/strict";
import { test } from "node:test";

import {
  verifyProductionAccess,
  verifyStagingAccess,
  verifyStagingServiceToken,
} from "./access-verifier.mjs";

const teamDomain = "https://scribe-drop-staging.cloudflareaccess.com";
const webOrigin = "https://scribe-drop-staging.example.invalid";
const serviceCredentials = {
  clientId: "0123456789abcdef0123456789abcdef.access",
  clientSecret: "a".repeat(64),
};
const accessAuthorization = JSON.stringify({
  "cf-access-client-id": serviceCredentials.clientId,
  "cf-access-client-secret": serviceCredentials.clientSecret,
});

function serviceTokenFor(payload) {
  return `header.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.signature`;
}

function validServiceTokenCookie() {
  return serviceTokenFor({
    common_name: serviceCredentials.clientId,
    sub: "",
    type: "app",
  });
}

function apiBoundaryResponse(body = "{}", status = 200) {
  return new Response(body, {
    headers: {
      "cache-control": "no-store",
      "content-type": "application/json; charset=utf-8",
      "x-content-type-options": "nosniff",
    },
    status,
  });
}

function accessRedirectFetch(input) {
  const url = new URL(input);
  return Promise.resolve(
    new Response(null, {
      headers: {
        location: `${teamDomain}/cdn-cgi/access/login/${url.hostname}${url.pathname}`,
      },
      status: 302,
    }),
  );
}

test("accepts Access redirects for the root and API boundary", async () => {
  await assert.doesNotReject(() => verifyStagingAccess(accessRedirectFetch, webOrigin, teamDomain));
});

test("rejects an origin response that bypasses Access", async () => {
  const bypassFetch = () => Promise.resolve(new Response("application", { status: 200 }));

  await assert.rejects(
    () => verifyStagingAccess(bypassFetch, webOrigin, teamDomain),
    /not protected by an Access login redirect/u,
  );
});

test("rejects redirects outside the expected Access team", async () => {
  const wrongTeamFetch = () =>
    Promise.resolve(
      new Response(null, {
        headers: {
          location: "https://attacker.example/cdn-cgi/access/login/stolen",
        },
        status: 302,
      }),
    );

  await assert.rejects(
    () => verifyStagingAccess(wrongTeamFetch, webOrigin, teamDomain),
    /outside the expected Access login boundary/u,
  );
});

test("rejects invalid Access team domains before making requests", async () => {
  let requests = 0;
  const countingFetch = () => {
    requests += 1;
    return Promise.resolve(new Response(null, { status: 302 }));
  };

  await assert.rejects(
    () => verifyStagingAccess(countingFetch, webOrigin, "https://example.com"),
    /must be an exact/u,
  );
  assert.equal(requests, 0);
});

test("rejects invalid Web origins before making requests", async () => {
  let requests = 0;
  const countingFetch = () => {
    requests += 1;
    return Promise.resolve(new Response(null, { status: 302 }));
  };

  await assert.rejects(
    () => verifyStagingAccess(countingFetch, "https://example.invalid/path", teamDomain),
    /must be an exact HTTPS origin/u,
  );
  assert.equal(requests, 0);
});

test("accepts production Access redirects and rejects staging markers", async () => {
  const productionTeamDomain = "https://scribe-drop-production.cloudflareaccess.com";
  const productionWebOrigin = "https://scribe-drop-production.example.invalid";
  const productionRedirectFetch = (input) => {
    const url = new URL(input);
    return Promise.resolve(
      new Response(null, {
        headers: {
          location: `${productionTeamDomain}/cdn-cgi/access/login/${url.hostname}${url.pathname}`,
        },
        status: 302,
      }),
    );
  };

  await assert.doesNotReject(() =>
    verifyProductionAccess(productionRedirectFetch, productionWebOrigin, productionTeamDomain),
  );
  await assert.rejects(
    () => verifyProductionAccess(productionRedirectFetch, webOrigin, productionTeamDomain),
    /mixed environment markers/u,
  );
  await assert.rejects(
    () => verifyProductionAccess(productionRedirectFetch, productionWebOrigin, teamDomain),
    /staging environment marker/u,
  );
});

test("verifies a staging service token session before protected API work", async () => {
  const requests = [];
  const authenticatedFetch = (input, init) => {
    const url = new URL(input);
    requests.push({
      headers: new Headers(init?.headers),
      url: url.href,
    });
    if (url.pathname === "/") {
      return Promise.resolve(
        new Response("application", {
          headers: {
            "set-cookie": `CF_Authorization=${validServiceTokenCookie()}; Path=/; Secure; HttpOnly`,
          },
          status: 200,
        }),
      );
    }
    if (url.pathname === "/api/me") {
      return Promise.resolve(apiBoundaryResponse('{"user":{"email":"service-principal.invalid"}}'));
    }
    return Promise.resolve(new Response(null, { status: 404 }));
  };

  const results = await verifyStagingServiceToken(
    authenticatedFetch,
    webOrigin,
    teamDomain,
    serviceCredentials.clientId,
    serviceCredentials,
  );

  assert.deepEqual(results, [
    { path: "/", status: 200 },
    { path: "/api/me", status: 200 },
  ]);
  assert.equal(requests.length, 2);
  for (const request of requests) {
    assert.equal(request.headers.get("authorization"), accessAuthorization);
    assert.equal(request.headers.get("CF-Access-Client-Id"), serviceCredentials.clientId);
    assert.equal(request.headers.get("CF-Access-Client-Secret"), serviceCredentials.clientSecret);
  }
  assert.equal(requests[0].headers.get("cookie"), null);
  assert.equal(requests[1].headers.get("cookie"), `CF_Authorization=${validServiceTokenCookie()}`);
});

test("follows only bounded same-origin redirects while establishing the service session", async () => {
  const requestedUrls = [];
  const redirectingFetch = (input) => {
    const url = new URL(input);
    requestedUrls.push(url.href);
    if (url.pathname === "/") {
      return Promise.resolve(
        new Response(null, {
          headers: {
            location: "/authenticated",
            "set-cookie": `CF_Authorization=${validServiceTokenCookie()}; Path=/; Secure; HttpOnly`,
          },
          status: 302,
        }),
      );
    }
    if (url.pathname === "/authenticated") {
      return Promise.resolve(new Response("application", { status: 200 }));
    }
    if (url.pathname === "/api/me") {
      return Promise.resolve(apiBoundaryResponse());
    }
    return Promise.resolve(new Response(null, { status: 404 }));
  };

  await assert.doesNotReject(() =>
    verifyStagingServiceToken(
      redirectingFetch,
      webOrigin,
      teamDomain,
      serviceCredentials.clientId,
      serviceCredentials,
    ),
  );
  assert.deepEqual(requestedUrls, [
    `${webOrigin}/`,
    `${webOrigin}/authenticated`,
    `${webOrigin}/api/me`,
  ]);
});

test("rejects a cookie-bearing Access login redirect when both layer credentials were sent", async () => {
  const requests = [];
  const cookieRedirectFetch = (input, init) => {
    const url = new URL(input);
    requests.push({
      headers: new Headers(init?.headers),
      url: url.href,
    });
    if (url.pathname === "/") {
      return Promise.resolve(
        new Response(null, {
          headers: {
            location: `${teamDomain}/cdn-cgi/access/login/bootstrap`,
            "set-cookie": `CF_Authorization=${validServiceTokenCookie()}; Path=/; Secure; HttpOnly`,
          },
          status: 302,
        }),
      );
    }
    return Promise.resolve(new Response(null, { status: 404 }));
  };

  await assert.rejects(
    () =>
      verifyStagingServiceToken(
        cookieRedirectFetch,
        webOrigin,
        teamDomain,
        serviceCredentials.clientId,
        serviceCredentials,
      ),
    /authentication was not accepted/u,
  );
  assert.deepEqual(
    requests.map((request) => request.url),
    [`${webOrigin}/`],
  );
  assert.equal(requests[0].headers.get("CF-Access-Client-Id"), serviceCredentials.clientId);
  assert.equal(requests[0].headers.get("authorization"), accessAuthorization);
});

test("does not follow an Access login redirect or send credentials to the team domain", async () => {
  const requestedUrls = [];
  const rejectedFetch = (input) => {
    const url = new URL(input);
    requestedUrls.push(url.href);
    return Promise.resolve(
      new Response(null, {
        headers: {
          location: `${teamDomain}/cdn-cgi/access/login/rejected`,
        },
        status: 302,
      }),
    );
  };

  await assert.rejects(
    () =>
      verifyStagingServiceToken(
        rejectedFetch,
        webOrigin,
        teamDomain,
        serviceCredentials.clientId,
        serviceCredentials,
      ),
    /authentication was not accepted/u,
  );
  assert.deepEqual(requestedUrls, [`${webOrigin}/`]);
});

test("rejects external redirects and invalid service-principal cookies", async () => {
  const externalRedirectFetch = () =>
    Promise.resolve(
      new Response(null, {
        headers: { location: "https://attacker.example/collect" },
        status: 302,
      }),
    );
  await assert.rejects(
    () =>
      verifyStagingServiceToken(
        externalRedirectFetch,
        webOrigin,
        teamDomain,
        serviceCredentials.clientId,
        serviceCredentials,
      ),
    /outside the exact staging origin/u,
  );

  const invalidCookieFetch = () =>
    Promise.resolve(
      new Response("application", {
        headers: {
          "set-cookie": `CF_Authorization=${serviceTokenFor({
            common_name: "ffffffffffffffffffffffffffffffff.access",
            sub: "",
            type: "app",
          })}; Path=/`,
        },
        status: 200,
      }),
    );
  await assert.rejects(
    () =>
      verifyStagingServiceToken(
        invalidCookieFetch,
        webOrigin,
        teamDomain,
        serviceCredentials.clientId,
        serviceCredentials,
      ),
    /expected service principal/u,
  );
});

test("fails before application work when the authenticated API boundary rejects the session", async () => {
  const requestedUrls = [];
  const apiRejectedFetch = (input) => {
    const url = new URL(input);
    requestedUrls.push(url.href);
    if (url.pathname === "/") {
      return Promise.resolve(
        new Response("application", {
          headers: {
            "set-cookie": `CF_Authorization=${validServiceTokenCookie()}; Path=/; Secure; HttpOnly`,
          },
          status: 200,
        }),
      );
    }
    return Promise.resolve(
      new Response(null, {
        headers: {
          location: `${teamDomain}/cdn-cgi/access/login/api-rejected`,
        },
        status: 302,
      }),
    );
  };

  await assert.rejects(
    () =>
      verifyStagingServiceToken(
        apiRejectedFetch,
        webOrigin,
        teamDomain,
        serviceCredentials.clientId,
        serviceCredentials,
      ),
    /\/api\/me staging Access authentication was not accepted/u,
  );
  assert.deepEqual(requestedUrls, [`${webOrigin}/`, `${webOrigin}/api/me`]);
});

test("does not accept a static HTML fallback as the authenticated API boundary", async () => {
  const staticFallbackFetch = (input) => {
    const url = new URL(input);
    if (url.pathname === "/") {
      return Promise.resolve(
        new Response("application", {
          headers: {
            "set-cookie": `CF_Authorization=${validServiceTokenCookie()}; Path=/; Secure; HttpOnly`,
          },
          status: 200,
        }),
      );
    }
    return Promise.resolve(
      new Response("<html>fallback</html>", {
        headers: { "content-type": "text/html" },
        status: 200,
      }),
    );
  };

  await assert.rejects(
    () =>
      verifyStagingServiceToken(
        staticFallbackFetch,
        webOrigin,
        teamDomain,
        serviceCredentials.clientId,
        serviceCredentials,
      ),
    /did not reach the authenticated API boundary/u,
  );
});

test("bounds same-origin redirects without accepting a missing service cookie", async () => {
  let requests = 0;
  const loopingFetch = () => {
    requests += 1;
    return Promise.resolve(
      new Response(null, {
        headers: { location: `/loop-${requests}` },
        status: 302,
      }),
    );
  };

  await assert.rejects(
    () =>
      verifyStagingServiceToken(
        loopingFetch,
        webOrigin,
        teamDomain,
        serviceCredentials.clientId,
        serviceCredentials,
      ),
    /exceeded the authenticated redirect limit/u,
  );
  assert.equal(requests, 5);
});

test("validates service credentials before network access and never includes them in errors", async () => {
  let requests = 0;
  const countingFetch = () => {
    requests += 1;
    return Promise.resolve(new Response(null, { status: 500 }));
  };

  await assert.rejects(
    () =>
      verifyStagingServiceToken(countingFetch, webOrigin, teamDomain, serviceCredentials.clientId, {
        ...serviceCredentials,
        clientSecret: `${serviceCredentials.clientSecret}\n`,
      }),
    (error) => {
      assert.doesNotMatch(error.message, /a{16}/u);
      return /invalid/u.test(error.message);
    },
  );
  assert.equal(requests, 0);
});
