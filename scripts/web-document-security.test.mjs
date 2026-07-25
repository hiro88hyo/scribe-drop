import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const indexHtml = readFileSync(new URL("../apps/web/index.html", import.meta.url), "utf8");

test("the document authenticates the manifest request without external scripts", () => {
  assert.match(
    indexHtml,
    /<link rel="manifest" href="\/manifest\.webmanifest" crossorigin="use-credentials" \/>/u,
  );
  assert.doesNotMatch(indexHtml, /<script[^>]+src=["']https:/u);
});
