export const productionFinalizeStages = Object.freeze([
  "smoke-active",
  "smoke-paused",
  "disabled-paused",
  "operational-paused",
  "operational-active",
]);

const transitions = Object.freeze({
  "smoke-active": Object.freeze({ action: "pause-admission", next: "smoke-paused" }),
  "smoke-paused": Object.freeze({ action: "disable-smoke", next: "disabled-paused" }),
  "disabled-paused": Object.freeze({ action: "authorize-operational", next: "operational-paused" }),
  "operational-paused": Object.freeze({ action: "activate-admission", next: "operational-active" }),
});

export function requireProductionFinalizeStage(value) {
  if (!productionFinalizeStages.includes(value)) {
    throw new Error("Production finalize entry stage is invalid");
  }
  return value;
}

export function productionFinalizeAdmission(stage) {
  const selected = requireProductionFinalizeStage(stage);
  return selected.endsWith("-active") ? "active" : "paused";
}

export function productionFinalizeAuthorization(stage) {
  const selected = requireProductionFinalizeStage(stage);
  if (selected.startsWith("smoke-")) return "smoke";
  if (selected.startsWith("disabled-")) return "disabled";
  return "operational";
}

export function productionFinalizePlan(stage) {
  let current = requireProductionFinalizeStage(stage);
  const actions = [];
  while (current !== "operational-active") {
    const transition = transitions[current];
    if (transition === undefined) {
      throw new Error("Production finalize state cannot converge");
    }
    actions.push(transition.action);
    current = transition.next;
  }
  return Object.freeze(actions);
}

export function applyProductionFinalizeAction(stage, action) {
  const selected = requireProductionFinalizeStage(stage);
  const transition = transitions[selected];
  if (transition === undefined || transition.action !== action) {
    throw new Error("Production finalize transition is invalid");
  }
  return transition.next;
}
