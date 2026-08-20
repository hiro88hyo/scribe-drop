import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const acceptance = readFileSync(
  new URL("../docs/acceptance-checklist.md", import.meta.url),
  "utf8",
);
const deployment = readFileSync(
  new URL("../docs/deployments/2026-07-31-v0.1.0-production.md", import.meta.url),
  "utf8",
);
const implementationPlan = readFileSync(
  new URL("../docs/implementation-plan.md", import.meta.url),
  "utf8",
);
const releaseReadiness = readFileSync(
  new URL("../docs/releases/0.1.0-production-readiness.md", import.meta.url),
  "utf8",
);

function section(document, heading, nextHeading) {
  const start = document.indexOf(heading);
  const end = document.indexOf(nextHeading, start + heading.length);
  assert.notEqual(start, -1, `${heading} is missing`);
  assert.notEqual(end, -1, `${nextHeading} is missing`);
  return document.slice(start, end);
}

test("keeps the v0.1.0 release decision and gate table complete", () => {
  assert.match(releaseReadiness, /- Status: Released/u);
  assert.match(releaseReadiness, /annotated `v0\.1\.0` tag/u);
  assert.match(releaseReadiness, /\.\.\/deployments\/2026-07-31-v0\.1\.0-production\.md/u);

  const releaseGates = section(
    releaseReadiness,
    "## Code and release gates",
    "## Automation gates",
  );
  const gateRows = releaseGates
    .split("\n")
    .filter((line) => line.startsWith("| ") && !line.startsWith("| Gate"))
    .filter((line) => !line.startsWith("| ---"));
  assert.equal(gateRows.length, 16);
  for (const row of gateRows) {
    const status = row.split("|")[2]?.trim();
    assert.equal(status, "Pass", `release gate is not complete: ${row}`);
  }
  for (const gate of [
    "GitHub required checks",
    "candidate SBOM、scan evidence",
    "formal staging acceptance evidence",
    "staging-to-production artifact promotion",
    "terminal失敗通知",
  ]) {
    assert.match(releaseGates, new RegExp(`\\| ${gate}\\s+\\| Pass\\s+\\|`, "u"));
  }
});

test("keeps acceptance, deployment, and implementation status synchronized", () => {
  assert.match(acceptance, /annotated tagまでPass/u);
  assert.doesNotMatch(acceptance, /\|\s+(?:Blocked|Gate|Pending)\s+\|/u);
  assert.match(deployment, /- Status: Released/u);
  assert.match(deployment, /`v0\.1\.0`をReleasedと判定した/u);
  assert.match(implementationPlan, /Phase 1からPhase 7の初回\nproduction releaseは完了/u);

  const deploymentRecord = "2026-07-31-v0.1.0-production.md";
  assert.match(acceptance, new RegExp(deploymentRecord.replaceAll(".", "\\."), "u"));
  assert.match(implementationPlan, new RegExp(deploymentRecord.replaceAll(".", "\\."), "u"));
});
