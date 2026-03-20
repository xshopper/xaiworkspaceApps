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

| App | Kind | Identifier | Description |
|-----|------|-----------|-------------|
| [@cliproxy](apps/cliproxy) | App | `com.xshopper.cliproxy` | CLI proxy — connect API keys for Grok, Claude, Gemini, OpenAI, etc. |
| [@email-manager](apps/email-manager) | App | `com.xshopper.email-manager` | Watches inbox, archives junk, summarizes important emails |
| [@expense-tracker](apps/expense-tracker) | App | `com.xshopper.expense-tracker` | Track expenses from receipts, invoices, and statements |
| [@code-reviewer](apps/code-reviewer) | App | `com.xshopper.code-reviewer` | Reviews PRs, checks security and code quality |
| [@sales-assistant](agents/sales-assistant) | Agent | `com.xshopper.sales-assistant` | Manage leads, draft proposals, track pipeline |
| [@support-bot](agents/support-bot) | Agent | `com.xshopper.support-bot` | Triage tickets, respond to common questions |
| [@summarize-text](skills/summarize-text) | Skill | `com.xshopper.summarize-text` | Summarize any text into key points |
| [@extract-data](skills/extract-data) | Skill | `com.xshopper.extract-data` | Extract structured data from unstructured text |
| [@google-sheets](tools/google-sheets) | Tool | `com.xshopper.google-sheets` | Read/write Google Sheets |
| [@github-issues](tools/github-issues) | Tool | `com.xshopper.github-issues` | Manage GitHub issues |

## Creating Your Own App

Create a `manifest.yml` in your repo:

```yaml
slug: my-app
kind: app
name: My App
description: What it does
icon: "\U0001F680"
version: 1.0.0
identifier: com.yourorg.my-app

permissions:
  resources: [storage]
  chat: [chat.send]

model: claude-sonnet-4-6
modelFallback: [claude-haiku-4-5-20251001]
sandbox: strict
```

For monorepos, add an `openclaw-workspace.yml` at the root:

```yaml
apps:
  - path: apps/my-first-app
  - path: apps/my-second-app
```

See [SDK.md](SDK.md) for the full manifest reference, permissions, triggers, persona system, and API docs.

## E2E Testing

Tests run via [Jest](https://jestjs.io/) + [Puppeteer](https://pptr.dev/) against a remote browser provided by [done24bot.com](https://done24bot.com).

```bash
# Install dependencies
npm install

# Run all tests (requires done24bot Chrome extension online)
D24_API_KEY=your_api_key npm test

# Run a specific app's tests
D24_API_KEY=your_api_key npm run test:email
```

Test specs live in `e2e/`. Each spec connects to xaiworkspace.com via done24bot's remote browser relay, logs in, and exercises the mini-app through the chat interface.

## License

MIT
