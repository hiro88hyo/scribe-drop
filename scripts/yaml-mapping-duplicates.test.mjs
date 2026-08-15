import assert from "node:assert/strict";
import test from "node:test";

import { parsers } from "prettier/plugins/yaml";

import { findYamlMappingDuplicates } from "./yaml-mapping-duplicates.mjs";

async function parse(source) {
  return parsers.yaml.parse(source, { filepath: "workflow.yml" });
}

test("finds duplicate keys only in the same YAML mapping", async () => {
  assert.deepEqual(
    findYamlMappingDuplicates(await parse("jobs:\n  one:\n    env:\n      A: 1\n      A: 2\n")),
    [{ firstLine: 4, key: "A", line: 5 }],
  );
  assert.deepEqual(
    findYamlMappingDuplicates(
      await parse("jobs:\n  one:\n    env:\n      A: 1\n  two:\n    env:\n      A: 2\n"),
    ),
    [],
  );
});
