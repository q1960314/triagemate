// Entry point for all backend Forge functions of TriageMate.
//
// Two kinds of functions live here:
//   - `handler`: the issue-panel resolver, re-exported from ./resolvers.
//     The frontend calls it with `invoke` from @forge/bridge.
//   - the four Rovo action functions below. Each one is referenced by key in
//     manifest.yml (modules.action[].function) and by the rovo:agent and
//     rovo:mcp modules. An action function receives (payload, context): the
//     payload carries the action inputs declared in the manifest, plus a
//     `context` object when the action runs inside an issue view.
//
// All four actions delegate to the shared logic in ./triage.js, so the agent,
// MCP clients and the issue panel always see the same data and the same
// suggestion for the same issue.

export { handler } from './resolvers';

import {
  fetchIssueByKey,
  fetchRelatedByKey,
  suggestTriageForKey,
  applyTriageToIssue,
} from './triage';

// Fetch a Jira issue by its key and return its summary, description, type,
// status, priority, labels, assignee, reporter and linked issues.
export async function fetchIssue(payload) {
  return fetchIssueByKey(payload.issueKey);
}

// Fetch an issue plus its triage context: linked issues, recent issues in the
// same project, the labels used in the project, and who recently handled
// similar issues.
export async function fetchRelatedIssues(payload) {
  return fetchRelatedByKey(payload.issueKey);
}

// Produce the four-item triage suggestion for an issue: priority, labels,
// suggested owner and confidence, each with a reason that cites real fields.
export async function suggestTriage(payload) {
  return suggestTriageForKey(payload.issueKey);
}

// Apply a triage suggestion to an issue. The payload must carry values that
// came from the suggest-triage output: a priority name, a comma-separated
// list of up to three labels, and the account ID of the suggested owner.
// Labels arrive as one comma-separated string because Rovo action inputs do
// not support array types.
export async function applyTriage(payload) {
  const labels = typeof payload.labels === 'string' && payload.labels.trim()
    ? payload.labels.split(',').map((label) => label.trim()).filter(Boolean)
    : undefined;
  return applyTriageToIssue(payload.issueKey, {
    priority: payload.priority || undefined,
    labels,
    assigneeAccountId: payload.assigneeAccountId || undefined,
  });
}
