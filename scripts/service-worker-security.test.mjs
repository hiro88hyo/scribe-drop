import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

const source = readFileSync(
  new URL("../apps/web/public/service-worker.js", import.meta.url),
  "utf8",
);
const offlineHtml = readFileSync(
  new URL("../apps/web/public/offline.html", import.meta.url),
  "utf8",
);

function loadHandlers({
  deleteImplementation = () => Promise.resolve(true),
  fetchImplementation,
  keysImplementation = () => Promise.resolve([]),
  matchImplementation,
  put,
}) {
  const listeners = new Map();
  const context = {
    URL,
    caches: {
      delete: deleteImplementation,
      keys: keysImplementation,
      match: matchImplementation,
      open: () =>
        Promise.resolve({
          put,
        }),
    },
    fetch: fetchImplementation,
    self: {
      addEventListener: (name, listener) => {
        listeners.set(name, listener);
      },
      clients: {
        claim: () => Promise.resolve(),
      },
      location: {
        origin: "https://app.example.invalid",
      },
      skipWaiting: () => Promise.resolve(),
    },
  };
  vm.runInNewContext(source, context, {
    filename: "service-worker.js",
  });
  return listeners;
}

function loadFetchHandler(options) {
  const listeners = loadHandlers(options);
  const handler = listeners.get("fetch");
  assert.equal(typeof handler, "function");
  return handler;
}

function request(pathname, overrides = {}) {
  return {
    method: "GET",
    mode: "cors",
    url: `https://app.example.invalid${pathname}`,
    ...overrides,
  };
}

test("service worker never intercepts API, artifact, or cross-origin requests", () => {
  let intercepted = false;
  const handler = loadFetchHandler({
    fetchImplementation: () => Promise.reject(new Error("must not fetch")),
    matchImplementation: () => Promise.resolve(undefined),
    put: () => Promise.resolve(),
  });
  const event = (targetRequest) => ({
    request: targetRequest,
    respondWith: () => {
      intercepted = true;
    },
  });

  handler(event(request("/api/jobs")));
  handler(event(request("/api/jobs/id/artifacts/markdown")));
  handler(
    event({
      ...request("/assets/app.js"),
      url: "https://storage.example.invalid/assets/app.js",
    }),
  );

  assert.equal(intercepted, false);
});

test("navigation is network-only with a static offline fallback and is never cached", async () => {
  const putCalls = [];
  const handler = loadFetchHandler({
    fetchImplementation: () => Promise.reject(new Error("offline")),
    matchImplementation: (key) =>
      Promise.resolve(key === "/offline.html" ? { marker: "offline" } : undefined),
    put: (...values) => {
      putCalls.push(values);
      return Promise.resolve();
    },
  });
  let responsePromise;

  handler({
    request: request("/jobs/id", { mode: "navigate" }),
    respondWith: (value) => {
      responsePromise = value;
    },
  });

  assert.deepEqual(await responsePromise, { marker: "offline" });
  assert.deepEqual(putCalls, []);
});

test("only reviewed same-origin static assets enter runtime cache", async () => {
  const putCalls = [];
  const networkResponse = {
    clone: () => ({ marker: "copy" }),
    ok: true,
    redirected: false,
    type: "basic",
    url: "https://app.example.invalid/assets/app.hash.js",
  };
  const handler = loadFetchHandler({
    fetchImplementation: () => Promise.resolve(networkResponse),
    matchImplementation: () => Promise.resolve(undefined),
    put: (...values) => {
      putCalls.push(values);
      return Promise.resolve();
    },
  });
  let responsePromise;
  const assetRequest = request("/assets/app.hash.js");

  handler({
    request: assetRequest,
    respondWith: (value) => {
      responsePromise = value;
    },
  });

  assert.equal(await responsePromise, networkResponse);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(putCalls.length, 1);
  assert.equal(putCalls[0][0], assetRequest);
});

test("redirected or cross-origin static responses never enter cache", async () => {
  for (const response of [
    {
      clone: () => ({ marker: "copy" }),
      ok: true,
      redirected: true,
      type: "basic",
      url: "https://app.example.invalid/assets/app.hash.js",
    },
    {
      clone: () => ({ marker: "copy" }),
      ok: true,
      redirected: false,
      type: "basic",
      url: "https://identity.example.invalid/login",
    },
  ]) {
    const putCalls = [];
    const handler = loadFetchHandler({
      fetchImplementation: () => Promise.resolve(response),
      matchImplementation: () => Promise.resolve(undefined),
      put: (...values) => {
        putCalls.push(values);
        return Promise.resolve();
      },
    });
    let responsePromise;

    handler({
      request: request("/assets/app.hash.js"),
      respondWith: (value) => {
        responsePromise = value;
      },
    });

    assert.equal(await responsePromise, response);
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.deepEqual(putCalls, []);
  }
});

test("activation deletes only obsolete ScribeDrop-owned caches", async () => {
  const deleted = [];
  const listeners = loadHandlers({
    deleteImplementation: (name) => {
      deleted.push(name);
      return Promise.resolve(true);
    },
    fetchImplementation: () => Promise.reject(new Error("must not fetch")),
    keysImplementation: () =>
      Promise.resolve([
        "scribe-drop-static-v0",
        "scribe-drop-static-v1",
        "unrelated-application-cache",
      ]),
    matchImplementation: () => Promise.resolve(undefined),
    put: () => Promise.resolve(),
  });
  const handler = listeners.get("activate");
  assert.equal(typeof handler, "function");
  let activation;
  handler({
    waitUntil: (value) => {
      activation = value;
    },
  });
  await activation;

  assert.deepEqual(deleted, ["scribe-drop-static-v0"]);
});

test("offline document contains no inline script, handler, or style", () => {
  assert.doesNotMatch(offlineHtml, /<script/iu);
  assert.doesNotMatch(offlineHtml, /\son[a-z]+=/iu);
  assert.doesNotMatch(offlineHtml, /<style/iu);
});
