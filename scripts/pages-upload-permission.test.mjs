import assert from "node:assert/strict";
import { test } from "node:test";

import { verifyPagesUploadPermission } from "./pages-upload-permission.mjs";

const input = {
  accountId: "a".repeat(32),
  apiToken: "token-with-pages-edit-permission",
  projectName: "scribe-drop-staging",
};

test("accepts an upload token response without returning the capability", async () => {
  const requests = [];
  const fetchImplementation = (url, init) => {
    requests.push({ headers: new Headers(init?.headers), method: init?.method, url });
    return Promise.resolve(
      Response.json({
        result: { jwt: "discarded-short-lived-upload-capability" },
        success: true,
      }),
    );
  };

  assert.deepEqual(await verifyPagesUploadPermission(fetchImplementation, input), {
    verified: true,
  });
  assert.equal(requests.length, 1);
  assert.equal(requests[0].method, "GET");
  assert.equal(requests[0].headers.get("authorization"), `Bearer ${input.apiToken}`);
  assert.match(requests[0].url, /\/upload-token$/u);
});

test("rejects missing permission without exposing the API response", async () => {
  await assert.rejects(
    () =>
      verifyPagesUploadPermission(
        () =>
          Promise.resolve(
            Response.json(
              {
                errors: [{ message: "sensitive provider detail" }],
                success: false,
              },
              { status: 403 },
            ),
          ),
        input,
      ),
    (error) => {
      assert.doesNotMatch(error.message, /sensitive provider detail/u);
      return /not available/u.test(error.message);
    },
  );
});

test("validates inputs before network access", async () => {
  let requests = 0;
  await assert.rejects(
    () =>
      verifyPagesUploadPermission(
        () => {
          requests += 1;
          return Promise.resolve(new Response());
        },
        { ...input, apiToken: `${input.apiToken}\n` },
      ),
    /CLOUDFLARE_PAGES_API_TOKEN/u,
  );
  assert.equal(requests, 0);
});
