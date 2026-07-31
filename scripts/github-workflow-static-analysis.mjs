function requireWorkflowSource(value) {
  if (typeof value !== "string") {
    throw new Error("GitHub workflow source is invalid");
  }
  return value;
}

export function findRunnerContextBeforeSteps(value) {
  const contents = requireWorkflowSource(value);
  const blockPattern = /^ {2}([a-z0-9-]+):\n/gmu;
  const matches = [...contents.matchAll(blockPattern)];
  const findings = [];

  for (const [index, match] of matches.entries()) {
    const start = match.index;
    const blockName = match[1];
    if (start === undefined || blockName === undefined) {
      continue;
    }
    const nextStart = matches[index + 1]?.index ?? contents.length;
    const block = contents.slice(start, nextStart);
    const stepsIndex = block.indexOf("    steps:\n");
    if (stepsIndex === -1) {
      continue;
    }
    if (block.slice(0, stepsIndex).includes("${{ runner.")) {
      findings.push(blockName);
    }
  }

  return findings;
}
