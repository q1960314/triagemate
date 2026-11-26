// Shared triage logic for TriageMate.
//
// Every function in this file is used by two entry points:
//   - the issue-panel resolver (src/resolvers/index.js), invoked from the UI Kit frontend
//   - the Rovo action functions (src/index.js), invoked by the Rovo agent or MCP clients
//
// All reads go through api.asUser() so Jira itself enforces the invoking user's
// permissions. Nothing in this file invents data: every reason in a suggestion
// names a real issue field, a real linked issue key, or a real project label.

import api, { route } from '@forge/api';

// Jira priority names, ordered from lowest to highest. The suggestion score
// is an index into this list, so the mapping is explicit and auditable.
const PRIORITIES = ['Lowest', 'Low', 'Medium', 'High', 'Highest'];

// Words that signal urgency when they appear in the summary or description.
// Each entry is [pattern, points, label shown in the reason]. Patterns are
// matched case-insensitively against the plain-text summary + description.
const URGENCY_SIGNALS = [
  // Critical: the product is broken for users right now.
  [/\bcrash(es|ed|ing)?\b/i, 2, 'crash'],
  [/崩溃/, 2, '崩溃'],
  [/\bdown\b/i, 2, 'down'],
  [/宕机/, 2, '宕机'],
  [/data loss/i, 2, 'data loss'],
  [/数据丢失/, 2, '数据丢失'],
  [/security/i, 2, 'security'],
  [/安全漏洞/, 2, '安全漏洞'],
  [/\bblocked\b/i, 2, 'blocked'],
  [/阻塞/, 2, '阻塞'],
  [/cannot log ?in/i, 2, 'cannot log in'],
  [/无法登录/, 2, '无法登录'],
  [/production/i, 1, 'production'],
  [/生产环境/, 1, '生产环境'],
  // Major: something is wrong and needs fixing soon.
  [/\berror\b/i, 1, 'error'],
  [/错误/, 1, '错误'],
  [/\bfail(ed|ure|ing)?\b/i, 1, 'fail'],
  [/失败/, 1, '失败'],
  [/\bbroken\b/i, 1, 'broken'],
  [/损坏/, 1, '损坏'],
  [/\burgent\b/i, 1, 'urgent'],
  [/紧急/, 1, '紧急'],
  // Minor: polish or documentation, safe to schedule late.
  [/\btypo\b/i, -1, 'typo'],
  [/错别字/, -1, '错别字'],
  [/cosmetic/i, -1, 'cosmetic'],
  [/样式/, -1, '样式'],
  [/\bdocs?\b/i, -1, 'docs'],
  [/文档/, -1, '文档'],
  [/refactor/i, -1, 'refactor'],
  [/重构/, -1, '重构'],
];

// A Jira issue key looks like PROJ-123: letters, then a dash, then digits.
const ISSUE_KEY_PATTERN = /^[A-Z][A-Z0-9]+-\d+$/;
const PROJECT_KEY_PATTERN = /^[A-Z][A-Z0-9]+$/;

function isValidIssueKey(issueKey) {
  return typeof issueKey === 'string' && ISSUE_KEY_PATTERN.test(issueKey.trim().toUpperCase());
}

function normalizeIssueKey(issueKey) {
  return issueKey.trim().toUpperCase();
}

// Turn an Atlassian Document Format (ADF) description into plain text so the
// scoring rules can read it. Unknown node types are walked, not dropped, so
// no text is silently lost.
function adfToText(node) {
  if (!node) {
    return '';
  }
  if (typeof node === 'string') {
    return node;
  }
  if (node.type === 'text') {
    return node.text || '';
  }
  if (Array.isArray(node.content)) {
    // Paragraphs and headings get a line break; inline nodes join directly.
    const joiner = node.type === 'paragraph' || node.type === 'heading' ? '\n' : '';
    return node.content.map(adfToText).join(joiner);
  }
  return '';
}

function truncate(text, maxLength) {
  if (!text || text.length <= maxLength) {
    return text || '';
  }
  return `${text.slice(0, maxLength)}…`;
}

// Low-level helper: call the Jira REST API as the invoking user and parse the
// JSON body. The first argument must be a Route built with the `route` tag
// from @forge/api: only single values may be interpolated, never a whole path
// string (the tag rejects path separators inside interpolations). On a
// non-2xx response it returns { ok: false, status, message } instead of
// throwing, so callers can turn it into a user-facing error.
async function requestJiraJson(routeObject, options) {
  const response = await api.asUser().requestJira(routeObject, {
    headers: { Accept: 'application/json' },
    ...options,
  });
  if (!response.ok) {
    let message = `Jira API returned HTTP ${response.status}`;
    try {
      const body = await response.text();
      if (body) {
        message = `${message}: ${truncate(body, 300)}`;
      }
    } catch (error) {
      // The status line alone is enough; ignore body-read failures.
    }
    return { ok: false, status: response.status, message };
  }
  // Jira write calls (e.g. PUT /issue) answer 204 No Content: there is no
  // body to parse, and response.json() on an empty body throws
  // "Unexpected end of JSON input" even though the write succeeded. Read
  // text first; an empty body means no data, not an error.
  const text = await response.text();
  if (!text) {
    return { ok: true, data: null };
  }
  try {
    return { ok: true, data: JSON.parse(text) };
  } catch (error) {
    return { ok: true, data: text };
  }
}

// Pick the fields the rest of the app needs out of a raw /issue response and
// drop everything else, so action payloads stay small and predictable.
function normalizeIssue(raw) {
  const fields = raw.fields || {};
  const linkedIssues = (fields.issuelinks || []).map((link) => {
    const other = link.outwardIssue || link.inwardIssue || {};
    const otherFields = other.fields || {};
    return {
      key: other.key,
      relationship: link.type ? link.type.name : '',
      direction: link.outwardIssue ? 'outward' : 'inward',
      summary: otherFields.summary || '',
      status: otherFields.status ? otherFields.status.name : '',
      priority: otherFields.priority ? otherFields.priority.name : '',
      type: otherFields.issuetype ? otherFields.issuetype.name : '',
    };
  }).filter((linked) => linked.key);
  return {
    key: raw.key,
    summary: fields.summary || '',
    description: truncate(adfToText(fields.description), 2000),
    type: fields.issuetype ? fields.issuetype.name : '',
    status: fields.status ? fields.status.name : '',
    priority: fields.priority ? fields.priority.name : '',
    labels: Array.isArray(fields.labels) ? fields.labels : [],
    assignee: fields.assignee ? {
      accountId: fields.assignee.accountId,
      displayName: fields.assignee.displayName,
    } : null,
    reporter: fields.reporter ? {
      accountId: fields.reporter.accountId,
      displayName: fields.reporter.displayName,
    } : null,
    projectKey: fields.project ? fields.project.key : '',
    projectName: fields.project ? fields.project.name : '',
    created: fields.created || '',
    updated: fields.updated || '',
    duedate: fields.duedate || '',
    linkedIssues,
  };
}

// Fetch one issue with the fields the triage needs. Returns
// { ok: true, issue } or { ok: false, error }.
export async function fetchIssueByKey(issueKey) {
  if (!isValidIssueKey(issueKey)) {
    return { ok: false, error: `Invalid issue key: ${issueKey}. Expected a key like PROJ-123.` };
  }
  const key = normalizeIssueKey(issueKey);
  const fields = 'summary,description,issuetype,status,priority,labels,assignee,reporter,project,issuelinks,created,updated,duedate';
  const result = await requestJiraJson(route`/rest/api/3/issue/${key}?fields=${fields}`);
  if (!result.ok) {
    return { ok: false, error: `Could not read issue ${key}: ${result.message}` };
  }
  return { ok: true, issue: normalizeIssue(result.data) };
}

// Fetch the issue plus the context a triage decision needs:
//   - linked issues (already on the issue itself)
//   - the 20 most recently updated issues in the same project
//   - the labels actually used on those recent issues
//   - who recently handled issues similar to this one
// Returns { ok: true, related } or { ok: false, error }.
export async function fetchRelatedByKey(issueKey) {
  const issueResult = await fetchIssueByKey(issueKey);
  if (!issueResult.ok) {
    return issueResult;
  }
  const issue = issueResult.issue;
  if (!issue.projectKey || !PROJECT_KEY_PATTERN.test(issue.projectKey)) {
    return { ok: false, error: `Issue ${issue.key} has no usable project key.` };
  }
  const jql = `project = ${issue.projectKey} ORDER BY updated DESC`;
  const fields = 'key,summary,issuetype,status,priority,labels,assignee,updated';
  const result = await requestJiraJson(route`/rest/api/3/search/jql?jql=${jql}&maxResults=20&fields=${fields}`);
  if (!result.ok) {
    return { ok: false, error: `Could not search recent issues in project ${issue.projectKey}: ${result.message}` };
  }
  const recentIssues = (result.data.issues || []).map((raw) => normalizeIssue(raw));

  // Labels that exist in this project, taken from real issues, most used first.
  // A suggested label must come from this list, never from thin air.
  const labelCounts = new Map();
  recentIssues.forEach((recent) => {
    recent.labels.forEach((label) => {
      labelCounts.set(label, (labelCounts.get(label) || 0) + 1);
    });
  });
  const projectLabels = [...labelCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([label]) => label);

  // Who recently handled a similar issue? Same issue type scores 2, sharing a
  // label scores 1 per shared label. The most frequent, then most recent,
  // handler wins. "Handled" here means "is the assignee of a recent issue",
  // which is the only handling signal the Jira API gives us cheaply.
  const targetWords = new Set(tokenize(`${issue.summary} ${issue.description}`));
  const candidateScores = new Map();
  recentIssues.forEach((recent) => {
    if (!recent.assignee || recent.key === issue.key) {
      return;
    }
    let score = 0;
    if (recent.type && recent.type === issue.type) {
      score += 2;
    }
    recent.labels.forEach((label) => {
      if (targetWords.has(label.toLowerCase())) {
        score += 1;
      }
    });
    if (score === 0) {
      return;
    }
    const existing = candidateScores.get(recent.assignee.accountId) || {
      accountId: recent.assignee.accountId,
      displayName: recent.assignee.displayName,
      score: 0,
      handledCount: 0,
      lastHandledKey: recent.key,
      lastHandledAt: recent.updated,
    };
    existing.score += score;
    existing.handledCount += 1;
    if (recent.updated > existing.lastHandledAt) {
      existing.lastHandledAt = recent.updated;
      existing.lastHandledKey = recent.key;
    }
    candidateScores.set(recent.assignee.accountId, existing);
  });
  const assigneeCandidates = [...candidateScores.values()]
    .sort((a, b) => b.score - a.score || b.lastHandledAt.localeCompare(a.lastHandledAt));

  return {
    ok: true,
    related: {
      issue,
      recentIssues: recentIssues.map((recent) => ({
        key: recent.key,
        summary: truncate(recent.summary, 200),
        type: recent.type,
        status: recent.status,
        priority: recent.priority,
        labels: recent.labels,
        assignee: recent.assignee,
        updated: recent.updated,
      })),
      projectLabels,
      assigneeCandidates,
    },
  };
}

// Split text into lowercase word tokens for label matching. ASCII words split
// on non-alphanumerics; CJK text is matched by substring elsewhere, so it is
// kept whole here.
function tokenize(text) {
  return text.toLowerCase().split(/[^a-z0-9\u4e00-\u9fff]+/).filter(Boolean);
}

// Build the four-item triage suggestion for an issue. This is pure logic over
// data already fetched, so the panel, the agent and MCP clients all get the
// same answer for the same issue. Returns { ok: true, suggestion } or
// { ok: false, error }.
export async function suggestTriageForKey(issueKey) {
  const relatedResult = await fetchRelatedByKey(issueKey);
  if (!relatedResult.ok) {
    return relatedResult;
  }
  const { issue, projectLabels, assigneeCandidates } = relatedResult.related;
  const searchableText = `${issue.summary}\n${issue.description}`;

  // --- 1. Priority: start at Medium (index 2) and move on real signals. ---
  const matchedSignals = [];
  let score = 2;
  URGENCY_SIGNALS.forEach(([pattern, points, label]) => {
    if (pattern.test(searchableText)) {
      score += points;
      matchedSignals.push(label);
    }
  });
  if (issue.type === 'Bug') {
    score += 1;
    matchedSignals.push(`type is Bug`);
  }
  const openBlockingLinks = issue.linkedIssues.filter(
    (linked) => linked.status !== 'Done' && (linked.priority === 'Highest' || linked.priority === 'High'),
  );
  if (openBlockingLinks.length > 0) {
    score += 1;
    matchedSignals.push(`linked to ${openBlockingLinks.map((linked) => linked.key).join(', ')} (${openBlockingLinks[0].priority}, open)`);
  }
  // Due date: an overdue issue is urgent even when its text is calm, and an
  // issue due within days is more urgent than one with no deadline. The due
  // date is a real field on the issue, not a guess. Overdue by N days adds 2,
  // due within the next 3 days (or today) adds 1.
  let dueDateEvidence = '';
  if (issue.duedate) {
    const due = new Date(`${issue.duedate}T00:00:00Z`);
    const now = new Date();
    const todayUtc = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
    const daysOverdue = Math.floor((todayUtc - due.getTime()) / 86400000);
    if (daysOverdue > 0) {
      score += 2;
      matchedSignals.push(`overdue by ${daysOverdue} day(s) (due ${issue.duedate})`);
      dueDateEvidence = `Due date ${issue.duedate}: overdue by ${daysOverdue} day(s)`;
    } else if (daysOverdue >= -3) {
      score += 1;
      matchedSignals.push(`due soon (${issue.duedate})`);
      dueDateEvidence = `Due date ${issue.duedate}: due within 3 days`;
    } else {
      dueDateEvidence = `Due date ${issue.duedate}: not due soon`;
    }
  }
  if (!issue.description && issue.linkedIssues.length === 0 && issue.type === 'Task') {
    score -= 1;
    matchedSignals.push('no description and no linked issues');
  }
  const clampedScore = Math.max(0, Math.min(4, score));
  const priority = PRIORITIES[clampedScore];
  let priorityReason;
  if (matchedSignals.length > 0) {
    priorityReason = `Priority ${priority}: ${matchedSignals.join('; ')}.`;
  } else {
    priorityReason = `Priority ${priority}: no urgency signals in the summary or description, no blocking links, and the issue type is ${issue.type || 'unknown'} — routine work.`;
  }

  // --- 2. Labels: only labels already used in this project, ranked by how ---
  // --- well they match the issue text. At most three, zero is allowed. ---
  const issueTokens = new Set(tokenize(searchableText));
  const scoredLabels = projectLabels.map((label) => {
    const labelLower = label.toLowerCase();
    let labelScore = 0;
    if (issueTokens.has(labelLower)) {
      labelScore += 2;
    }
    issueTokens.forEach((token) => {
      if (token.length > 3 && labelLower.includes(token)) {
        labelScore += 1;
      }
    });
    if (searchableText.toLowerCase().includes(labelLower)) {
      labelScore += 1;
    }
    return { label, score: labelScore };
  }).filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 3);
  const labels = scoredLabels.map((entry) => entry.label);
  const labelsReason = labels.length > 0
    ? `Labels ${labels.join(', ')}: each is already used on issues in project ${issue.projectKey} and matches words in this issue's summary or description.`
    : `No labels suggested: none of the labels used in project ${issue.projectKey} matches this issue's text, and inventing a label would be worse than leaving labels unchanged.`;

  // --- 3. Assignee: the top candidate from recent similar work, or nobody. ---
  let assignee;
  if (assigneeCandidates.length > 0) {
    const best = assigneeCandidates[0];
    assignee = {
      accountId: best.accountId,
      displayName: best.displayName,
      reason: `Suggested owner ${best.displayName}: assignee of ${best.handledCount} recent ${issue.type || ''} issue(s) in project ${issue.projectKey}, most recently ${best.lastHandledKey}.`,
    };
  } else {
    assignee = {
      accountId: null,
      displayName: '无人选',
      reason: `No owner suggested: nobody in project ${issue.projectKey} was the assignee of a recent similar issue (checked the 20 most recently updated issues), so there is no evidence-based owner to name.`,
    };
  }

  // --- 4. Confidence: count independent signals. ---
  const evidence = [];
  if (matchedSignals.length > 0) {
    evidence.push(`Issue text and type: ${matchedSignals.join('; ')}`);
  }
  if (openBlockingLinks.length > 0) {
    evidence.push(`Linked issues: ${openBlockingLinks.map((linked) => `${linked.key} (${linked.priority}, ${linked.status})`).join(', ')}`);
  }
  if (labels.length > 0) {
    evidence.push(`Project labels in use: ${labels.join(', ')}`);
  }
  if (dueDateEvidence) {
    evidence.push(dueDateEvidence);
  }
  if (assigneeCandidates.length > 0) {
    evidence.push(`Same-type precedent: ${assigneeCandidates[0].displayName} handled ${assigneeCandidates[0].handledCount} recent similar issue(s)`);
  }
  if (issue.description) {
    evidence.push(`Description present (${issue.description.length} characters)`);
  } else {
    evidence.push('Description is empty');
  }
  // Independent signals: text/type signals, blocking links, label matches,
  // assignee precedent. Three or more means high confidence.
  const signalCount = (matchedSignals.length > 0 ? 1 : 0)
    + (openBlockingLinks.length > 0 ? 1 : 0)
    + (labels.length > 0 ? 1 : 0)
    + (assigneeCandidates.length > 0 ? 1 : 0);
  const confidence = signalCount >= 3 ? '高' : signalCount >= 1 ? '中' : '低';

  return {
    ok: true,
    suggestion: {
      issueKey: issue.key,
      summary: issue.summary,
      currentPriority: issue.priority,
      currentLabels: issue.labels,
      currentAssignee: issue.assignee,
      priority: { value: priority, reason: priorityReason },
      labels: { values: labels, reason: labelsReason },
      assignee,
      confidence: { level: confidence, evidence },
    },
  };
}

// Apply a triage suggestion to an issue: set priority, labels and assignee.
// Only the fields actually passed are written; a missing field is left alone.
// After the write, the issue is read back so the caller can verify the new
// state matches the suggestion. Returns { ok: true, applied, verified } or
// { ok: false, error }.
export async function applyTriageToIssue(issueKey, changes) {
  if (!isValidIssueKey(issueKey)) {
    return { ok: false, error: `Invalid issue key: ${issueKey}. Expected a key like PROJ-123.` };
  }
  const key = normalizeIssueKey(issueKey);
  const fields = {};
  const applied = {};

  if (changes.priority) {
    if (!PRIORITIES.includes(changes.priority)) {
      return { ok: false, error: `Invalid priority "${changes.priority}". Use one of: ${PRIORITIES.join(', ')}.` };
    }
    fields.priority = { name: changes.priority };
    applied.priority = changes.priority;
  }
  if (Array.isArray(changes.labels)) {
    const cleanLabels = [...new Set(changes.labels.map((label) => String(label).trim()).filter(Boolean))].slice(0, 3);
    fields.labels = cleanLabels;
    applied.labels = cleanLabels;
  }
  if (changes.assigneeAccountId) {
    fields.assignee = { accountId: String(changes.assigneeAccountId).trim() };
    applied.assigneeAccountId = fields.assignee.accountId;
  }
  if (Object.keys(fields).length === 0) {
    return { ok: false, error: 'Nothing to apply: no priority, labels or assignee were provided.' };
  }

  const updateResult = await requestJiraJson(route`/rest/api/3/issue/${key}`, {
    method: 'PUT',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify({ fields }),
  });
  if (!updateResult.ok) {
    return { ok: false, error: `Could not update issue ${key}: ${updateResult.message}` };
  }

  // Read the issue back and confirm the write landed.
  const readBack = await fetchIssueByKey(key);
  if (!readBack.ok) {
    return { ok: false, error: `Update succeeded but the issue could not be read back: ${readBack.error}` };
  }
  const verified = {
    priority: readBack.issue.priority,
    labels: readBack.issue.labels,
    assignee: readBack.issue.assignee,
  };
  return { ok: true, applied, verified, issueKey: key };
}
