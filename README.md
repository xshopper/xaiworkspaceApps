# xAI Workspace Apps

Official app repository for [xAI Workspace](https://xaiworkspace.com). Contains apps, agents, skills, and tools that can be installed directly from the platform.

## Install

From xAI Workspace chat:

```
/install https://github.com/xshopper/xaiworkspaceApps
```

This installs **all apps** in the monorepo. To install a specific app:

```
/install https://github.com/xshopper/xaiworkspaceApps/tree/main/apps/email-manager
```

Or by slug (if already published to the registry):

```
/install @email-manager
```

## Apps

| App | Kind | Description |
|-----|------|-------------|
| [@email-manager](apps/email-manager) | App | Watches inbox, archives junk, summarizes important emails |
| [@expense-tracker](apps/expense-tracker) | App | Track expenses from receipts, invoices, and statements |
| [@code-reviewer](apps/code-reviewer) | App | Reviews PRs, checks security and code quality |
| [@sales-assistant](agents/sales-assistant) | Agent | Manage leads, draft proposals, track pipeline |
| [@support-bot](agents/support-bot) | Agent | Triage tickets, respond to common questions |
| [@summarize-text](skills/summarize-text) | Skill | Summarize any text into key points |
| [@extract-data](skills/extract-data) | Skill | Extract structured data from unstructured text |
| [@google-sheets](tools/google-sheets) | Tool | Read/write Google Sheets |
| [@github-issues](tools/github-issues) | Tool | Manage GitHub issues |

## Creating Your Own App

Create a `manifest.yml` in your repo:

```yaml
slug: my-app
kind: app
name: My App
description: What it does
icon: "\U0001F680"
version: 1.0.0

permissions:
  resources: [storage]
  chat: [chat.send]

model: claude-sonnet-4-6
sandbox: strict
```

For monorepos, add an `openclaw-workspace.yml` at the root:

```yaml
apps:
  - path: apps/my-first-app
  - path: apps/my-second-app
```

## License

MIT
