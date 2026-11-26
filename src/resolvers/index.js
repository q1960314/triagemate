// Resolver for the TriageMate Jira issue panel.
//
// The frontend invokes these definitions through `invoke` from @forge/bridge.
// Each definition is a thin wrapper around the shared logic in ../triage.js:
// the same functions also back the Rovo actions, so the panel, the agent and
// MCP clients always agree on what a suggestion is.

import Resolver from '@forge/resolver';
import {
  fetchIssueByKey,
  fetchRelatedByKey,
  suggestTriageForKey,
  applyTriageToIssue,
} from '../triage';

const resolver = new Resolver();

// Read the current issue: summary, description, type, status, priority,
// labels, assignee, reporter and linked issues.
resolver.define('getIssue', async (req) => {
  const issueKey = req.payload && req.payload.issueKey;
  return fetchIssueByKey(issueKey);
});

// Read the issue plus its triage context: linked issues, the 20 most recently
// updated issues in the same project, the labels used in the project, and who
// recently handled similar issues.
resolver.define('getRelatedIssues', async (req) => {
  const issueKey = req.payload && req.payload.issueKey;
  return fetchRelatedByKey(issueKey);
});

// Produce the four-item triage suggestion for the issue: priority + reason,
// labels + reason, suggested owner (or "无人选") + reason, confidence + evidence.
resolver.define('getSuggestion', async (req) => {
  const issueKey = req.payload && req.payload.issueKey;
  return suggestTriageForKey(issueKey);
});

// Apply a suggestion to the issue. The payload carries the suggestion the
// user confirmed in the panel: priority, labels and assigneeAccountId. Only
// the fields present in the payload are written; the issue is read back
// afterwards so the panel can show the verified new state.
resolver.define('applySuggestion', async (req) => {
  const payload = req.payload || {};
  return applyTriageToIssue(payload.issueKey, {
    priority: payload.priority,
    labels: payload.labels,
    assigneeAccountId: payload.assigneeAccountId,
  });
});

export const handler = resolver.getDefinitions();
