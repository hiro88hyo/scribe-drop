import assert from "node:assert/strict";
import { test } from "node:test";

import { verifyStagingAccess } from "./staging-access-verifier.mjs";

const teamDomain = "https://scribe-drop-staging.cloudflareaccess.com";
const webOrigin = "https://scribe-drop-staging.example.invalid";

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
