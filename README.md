# TriageMate for Jira

A Forge app for [Codegeist 2026](https://codegeist2026.devpost.com/) (track: Apps for Software Teams; bonuses: Best Agents — Rovo, Best app with Atlassian MCP).

A Rovo agent reads a Jira issue and proposes a triage suggestion. A Jira issue panel shows the same suggestion, and you confirm to apply it. The same four actions are also exposed as MCP tools, so any MCP client can drive the same triage flow.

## What it suggests

For any Jira issue, TriageMate proposes four items, each with a reason that cites real issue fields:

1. **Priority** — scored from urgency words in the text, issue type, open high-priority linked issues, and the due date (overdue raises it; due within 3 days raises it slightly).
2. **Labels** — 0–3 labels, taken only from labels already used in the project, matched against the issue's words.
3. **Suggested owner** — someone who recently handled similar issues in the project. If nobody qualifies, it says so with the reason. It never invents a person.
4. **Confidence** — high / medium / low, with the evidence used (issue fields, linked-issue keys, precedent counts).

Nothing is applied without confirmation: the panel has an "Apply suggestion" button, and the agent asks before applying.

## Modules

- `jira:issuePanel` — "TriageMate" panel on the issue view.
- `rovo:agent` — "Triage Agent" with conversation starters ("Triage this issue", "Why this priority?", "Who should own this?").
- `rovo:mcp` — "Triage MCP" exposing four tools: `fetch-issue`, `fetch-related-issues`, `suggest-triage`, `apply-triage`.
- Scopes: `read:jira-work`, `write:jira-work` (write is only used by apply-triage).

## Install

Use the installation link from the Codegeist submission (production version). The app installs on any Jira Cloud site; open any issue and the TriageMate panel appears in the issue view.

## Run locally

Requires Node 20+ and the Forge CLI.

```bash
npm install
forge deploy -e development
forge install --product Jira --site <your-site>.atlassian.net -e development
```

## Layout

- `manifest.yml` — modules, scopes, `app.rovo` metadata.
- `src/triage.js` — the shared deterministic triage logic (scoring, precedent, labels, apply).
- `src/resolvers/index.js` — panel resolvers.
- `src/index.js` — Rovo action functions.
- `src/frontend/index.jsx` — the issue-panel UI (UI Kit).
- `prompts/prompt.md` — the agent's workflow prompt.
