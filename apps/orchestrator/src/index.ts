export const ORCHESTRATOR_APPLICATION_ID = "scribe-drop-orchestrator";

export default {
  fetch(): Response {
    return new Response(null, { status: 404 });
  },
};
