import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const ignoreFileUrl = new URL("../tools/trivy-gpu-controller-ignore.yaml", import.meta.url);
const packageJsonUrl = new URL("../package.json", import.meta.url);

const expectedIgnoreFile = `vulnerabilities:
  - id: CVE-2026-14456
    purls:
      - "pkg:deb/debian/libssl3t64@3.5.6-1~deb13u2?arch=amd64&distro=debian-13.6"
    expired_at: 2026-09-20
    statement: >-
      Not affected: the controller is a TCP HTTP service, does not create an OpenSSL QUIC listener,
      and its offline container invariant proves that the Node process does not load the operating-system libssl shared object.
`;

test("keeps the controller vulnerability exception exact, scoped, and time bounded", () => {
  const ignoreFile = readFileSync(ignoreFileUrl, "utf8");
  assert.equal(ignoreFile, expectedIgnoreFile);
  assert.ok(Date.now() < Date.parse("2026-09-20T00:00:00Z"), "controller exception has expired");

  const packageJson = JSON.parse(readFileSync(packageJsonUrl, "utf8"));
  const scripts = packageJson.scripts;
  assert.equal(
    scripts["container:scan:gpu-controller"],
    "./.tools/bin/trivy image --cache-dir .tools/trivy-cache --scanners vuln --severity HIGH,CRITICAL --ignore-unfixed=false --ignorefile tools/trivy-gpu-controller-ignore.yaml --exit-code 1 --format table --table-mode detailed --quiet --skip-version-check --timeout 15m scribe-drop-gpu-controller:local",
  );

  const users = Object.entries(scripts)
    .filter(([, command]) => command.includes("tools/trivy-gpu-controller-ignore.yaml"))
    .map(([name]) => name);
  assert.deepEqual(users, ["container:scan:gpu-controller"]);
});
