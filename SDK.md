# xAI Workspace Mini Apps SDK

A reference guide for developers building apps, agents, skills, tools, and plugins on the xAI Workspace platform.

---

## Table of Contents

1. [Overview](#overview)
2. [Quick Start](#quick-start)
3. [Manifest Reference](#manifest-reference)
4. [App Kinds](#app-kinds)
5. [Permissions](#permissions)
6. [Triggers](#triggers)
7. [Persona System](#persona-system)
8. [Sandbox and Security](#sandbox-and-security)
9. [Publishing](#publishing)
10. [API Reference](#api-reference)
11. [Examples](#examples)

---

## Overview

xAI Workspace Mini Apps are YAML-defined components that extend an OpenClaw instance with new capabilities. A single `manifest.yml` file describes what a component does, what permissions it needs, and how it behaves — the platform handles execution, sandboxing, authentication, and lifecycle management.

### The Five Primitives

| Kind | Purpose | When to use |
|------|---------|-------------|
| **App** | Stateful, user-facing application with an ongoing presence | Email managers, expense trackers, dashboards — things with persistent state and regular interaction |
| **Agent** | Autonomous AI persona with goals, memory, and decision-making | Specialised assistants (sales, support, research) that operate with significant autonomy |
| **Skill** | Stateless, single-purpose function with defined input and output | Reusable building blocks — summarisation, extraction, classification |
| **Tool** | Authenticated HTTP adapter to an external API | Wrapping third-party REST APIs (Google Sheets, GitHub, Slack) so agents can call them |
| **Plugin** | Lifecycle hook that intercepts or augments the AI pipeline | Pre/post-processing, content moderation, response auditing |

All five share the same manifest format. Differences are in which fields apply and how the platform executes them.

---

## Quick Start

Create a directory for your app and add a `manifest.yml`:

```
my-app/
└── manifest.yml
```

```yaml
slug: my-first-app
kind: app
name: My First App
description: A simple app that greets users by name
icon: 👋
version: 0.1.0

persona:
  soul: You are a friendly greeter. Keep responses warm and brief.
  rules: |
    - Always address the user by their first name if you know it
    - Keep greetings to two sentences or fewer

permissions:
  chat: [chat.send, chat.read]

model: claude-haiku-4-5-20251001
sandbox: strict
```

Install it from the xAI Workspace chat:

```
/install https://github.com/yourname/my-app
```

That's it. The platform validates the manifest, provisions the app against your instance, and makes it available immediately.

---

## Manifest Reference

Every manifest is a YAML file named `manifest.yml` at the root of the app directory.

### Core Fields

These fields apply to all five kinds.

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `slug` | string | Yes | — | Unique identifier. Kebab-case, 3–100 characters. Pattern: `/^[a-z0-9][a-z0-9-]{1,98}[a-z0-9]$/` |
| `kind` | string | Yes | — | One of: `app`, `agent`, `skill`, `tool`, `plugin` |
| `name` | string | Yes | — | Human-readable display name. Max 200 characters |
| `description` | string | Yes | — | What the component does. Shown in the marketplace |
| `icon` | string | No | Varies by kind | Emoji icon. Defaults: app=📦, agent=🤖, skill=⚡, tool=🔧, plugin=🔌 |
| `version` | string | No | `0.1.0` | Semantic version (e.g. `1.2.3`) |
| `model` | string | No | Platform default | Preferred AI model (e.g. `claude-sonnet-4-6`, `claude-haiku-4-5-20251001`) |
| `modelFallback` | array | No | — | Ordered list of fallback models if the preferred model is unavailable |
| `sandbox` | string | No | `strict` | Execution isolation level: `strict`, `relaxed`, or `none` |
| `categories` | array | No | — | Marketplace category tags (e.g. `[productivity, communication]`) |

### Optional Fields

| Field | Type | Description |
|-------|------|-------------|
| `permissions` | object | Declared resource, chat, and integration access |
| `triggers` | array | Events or schedules that activate the component |
| `persona` | object | Personality, rules, and knowledge injected into the system prompt |
| `approvalRequired` | array | Action names that require explicit user confirmation before execution |
| `dependencies` | array | Slugs of skills or tools this component requires |
| `entrypoint` | string | Inline JavaScript executed inside the sandbox for programmatic components |

### Skill-Specific Fields

| Field | Type | Description |
|-------|------|-------------|
| `input` | object | JSON Schema describing the expected input object |
| `output` | object | JSON Schema describing the returned output object |

### Tool-Specific Fields

| Field | Type | Description |
|-------|------|-------------|
| `authProvider` | string | Built-in OAuth provider: `google`, `github`, `slack`, `stripe`, `notion` |
| `auth` | object | Custom OAuth provider config (use instead of `authProvider` for non-built-in services) |
| `baseUrl` | string | Base URL prepended to all operation paths |
| `operations` | array | List of HTTP operations the tool exposes (see below) |

**Built-in vs custom auth:**

Use `authProvider` for built-in providers (Google, GitHub, Slack, Stripe, Notion) — the platform manages OAuth credentials automatically.

Use `auth` for any other service — you supply the OAuth endpoints in the manifest, and provide `clientId` + `clientSecret` separately via the API after publishing (secrets never go in the manifest).

**`auth` object fields:**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `name` | string | No | Display name for the OAuth provider (e.g. "My CRM") |
| `authUrl` | string | Yes | OAuth authorization endpoint URL |
| `tokenUrl` | string | Yes | OAuth token exchange endpoint URL |
| `scopes` | string | No | Space-separated OAuth scopes |
| `refreshable` | boolean | No | Whether the provider supports refresh tokens |

Example with custom auth:

```yaml
kind: tool
slug: my-crm-tool
name: My CRM
auth:
  name: Acme CRM
  authUrl: https://acmecrm.com/oauth/authorize
  tokenUrl: https://acmecrm.com/oauth/token
  scopes: contacts.read contacts.write
  refreshable: true
baseUrl: https://api.acmecrm.com/v1
operations:
  - name: list
    description: List contacts
    method: GET
    path: /contacts
```

After publishing, set the OAuth credentials (once, not per-user):

```bash
curl -X POST https://router.xaiworkspace.com/api/mini-apps/my-crm-tool/auth \
  -H "Authorization: Bearer $YOUR_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{ "clientId": "your-oauth-client-id", "clientSecret": "your-oauth-client-secret" }'
```

Each user who installs the tool will go through the OAuth flow using your app credentials, and get their own access token.

Each operation in `operations`:

| Field | Type | Description |
|-------|------|-------------|
| `name` | string | Operation identifier |
| `description` | string | What the operation does — used for AI tool selection |
| `method` | string | HTTP method: `GET`, `POST`, `PUT`, `PATCH`, `DELETE` |
| `path` | string | Path appended to `baseUrl`. Supports `{param}` path variables. Can be an absolute URL (e.g. `https://other-api.com/endpoint`) to override `baseUrl` for specific operations |
| `query` | object | Default query parameters merged into every request for this operation |

### Plugin-Specific Fields

| Field | Type | Description |
|-------|------|-------------|
| `hooks` | array | Lifecycle points to intercept: `pre`, `post`, `error`, `approval` |

---

## App Kinds

### App

An App is a stateful, user-facing component with an ongoing presence in the workspace. Apps persist state across sessions, can respond to triggers, and maintain a consistent persona.

Use apps when:
- The component needs to remember things between conversations
- It monitors something over time (inbox, feeds, dashboards)
- Users will interact with it repeatedly as a named entity

```yaml
slug: expense-tracker
kind: app
name: Expense Tracker
description: Track business expenses from receipts, invoices, and bank statements. Categorize and generate reports.
icon: 💰
version: 1.0.0

persona:
  soul: You are a meticulous financial assistant. Be precise with numbers, always use the user's preferred currency.
  rules: |
    - Always confirm amounts before recording
    - Categorize expenses using standard business categories
    - Flag duplicate entries
    - Never modify past entries without approval

permissions:
  resources: [storage, database]
  chat: [chat.send, chat.read]

triggers:
  - kind: event
    config: { event: "file.uploaded", filter: { mime: ["image/jpeg", "image/png", "application/pdf"] } }

model: claude-sonnet-4-6
sandbox: strict
approvalRequired: [expense.delete, report.export]
```

### Agent

An Agent is an autonomous AI persona with goals, memory, and the ability to take sequences of actions. Agents are more proactive than apps — they run on schedules, monitor for conditions, and act without being explicitly prompted.

Use agents when:
- The component should make decisions and act with significant autonomy
- It needs a strong, consistent personality across all interactions
- It operates asynchronously on behalf of the user

```yaml
slug: sales-assistant
kind: agent
name: Sales Assistant
description: Helps manage leads, draft proposals, follow up with prospects, and track pipeline
icon: 💼
version: 1.0.0

persona:
  soul: |
    You are a friendly, professional sales assistant. You understand B2B sales cycles,
    can draft compelling proposals, and help prioritize leads by potential value.
    Always be encouraging but realistic about deal prospects.
  rules: |
    - Never share client data between different prospects
    - Always confirm before sending outbound messages
    - Track all interactions for pipeline reporting
    - Respect timezone preferences for follow-up scheduling
  knowledge: |
    Sales methodology: MEDDIC (Metrics, Economic Buyer, Decision Criteria,
    Decision Process, Identify Pain, Champion).

permissions:
  resources: [storage, database, email]
  chat: [chat.send, chat.listen]

triggers:
  - kind: cron
    config: { cron: "0 9 * * 1-5" }
  - kind: event
    config: { event: "email.received", filter: { label: "sales" } }

model: claude-sonnet-4-6
modelFallback: [claude-haiku-4-5-20251001]
sandbox: strict
approvalRequired: [email.send, proposal.send]
```

### Skill

A Skill is a stateless, single-purpose function. It takes a defined input, performs one task well, and returns a defined output. Skills have no memory, no persona, and no side effects beyond their return value.

Skills are the building blocks of the platform. Apps and agents declare skills as dependencies and call them by name. A well-designed skill does exactly one thing and can be reused across many different apps.

Use skills when:
- The component is purely functional (input in, output out)
- Other apps and agents would benefit from reusing it
- State and persona would add unnecessary complexity

```yaml
slug: summarize-text
kind: skill
name: Summarize Text
description: Summarizes any text into key points — emails, documents, articles, chat threads
icon: ⚡
version: 1.0.0

input:
  type: object
  properties:
    text:
      type: string
      description: The text to summarize
    maxPoints:
      type: integer
      description: Maximum number of bullet points
      default: 5
    style:
      type: string
      enum: [bullets, paragraph, tldr]
      default: bullets
  required: [text]

output:
  type: object
  properties:
    summary:
      type: string
    pointCount:
      type: integer

model: claude-haiku-4-5-20251001
sandbox: strict
```

**Calling a skill from another component:**

Declare it in `dependencies` and invoke it by name in your entrypoint or via the AI's tool-calling capability:

```yaml
dependencies: [summarize-text]
```

The platform ensures the skill is installed before your component activates.

### Tool

A Tool wraps an external REST API and exposes its operations to the AI in a structured way. The platform handles OAuth token management, header injection, and request forwarding — you declare what operations exist and the AI figures out when and how to call them.

Tools do not contain AI logic. They are pure HTTP adapters.

Use tools when:
- You want to give an agent or app access to a third-party service
- The service has a REST API and OAuth support
- You want the platform to handle authentication on behalf of the user

```yaml
slug: github-issues
kind: tool
name: GitHub Issues
description: Create, read, update, and manage GitHub issues and labels
icon: 🐛
version: 1.0.0

authProvider: github
baseUrl: https://api.github.com

operations:
  - name: list
    description: List issues for a repository
    method: GET
    path: /repos/{owner}/{repo}/issues
  - name: create
    description: Create a new issue
    method: POST
    path: /repos/{owner}/{repo}/issues
  - name: update
    description: Update an existing issue
    method: PATCH
    path: /repos/{owner}/{repo}/issues/{issue_number}
  - name: comment
    description: Add a comment to an issue
    method: POST
    path: /repos/{owner}/{repo}/issues/{issue_number}/comments
  - name: close
    description: Close an issue
    method: PATCH
    path: /repos/{owner}/{repo}/issues/{issue_number}

permissions:
  integrations: [github]

sandbox: strict
```

The `description` on each operation is critical — it is what the AI reads when deciding which operation to call. Write clear, specific descriptions that distinguish operations from each other.

### Plugin

A Plugin intercepts the AI pipeline at defined lifecycle points. It runs before the AI responds (`pre`), after the AI responds (`post`), when an error occurs (`error`), or when a user approval action is triggered (`approval`).

Plugins are the most powerful and most constrained primitive. They must declare an `entrypoint` (inline JavaScript) and run with limited ambient authority.

Use plugins when:
- You need to modify or inspect every message passing through the AI
- You want to enforce content policies or audit trails
- You need to transform AI output before it reaches the user

```yaml
slug: content-safety
kind: plugin
name: Content Safety Filter
description: Screens AI responses for policy violations before delivery
icon: 🔌
version: 1.0.0

hooks: [post, error]

entrypoint: |
  export async function post({ response, context }) {
    const flagged = await checkPolicy(response.content);
    if (flagged) {
      return { ...response, content: '[Response removed by content policy]' };
    }
    return response;
  }

sandbox: strict
```

---

## Permissions

Permissions are declared up front in the manifest and enforced at runtime. A component can only access resources it has declared. Requesting a permission the user has not granted causes the operation to fail silently inside the sandbox.

### Permission Groups

**resources** — Storage and backend access:

| Permission | What it grants |
|-----------|---------------|
| `storage` | Key-value storage scoped to the component |
| `email` | Read and send email via the user's connected email account |
| `database` | Structured data persistence (tables, queries) |
| `functions` | Ability to invoke serverless functions |

**chat** — Message channel access:

| Permission | What it grants |
|-----------|---------------|
| `chat.send` | Send messages to the user's chat |
| `chat.read` | Read conversation history |
| `chat.listen` | Receive real-time incoming messages |
| `tool.execute` | Call installed tools |
| `tool.list` | Enumerate available tools |
| `memory.read` | Read from the AI's long-term memory |
| `memory.write` | Write to the AI's long-term memory |

**device** — User device access (requires explicit user grant):

| Permission | What it grants |
|-----------|---------------|
| `device.camera` | Access device camera |
| `device.location` | Access device GPS location |
| `device.clipboard` | Read/write clipboard |
| `device.share` | Trigger native share sheet |
| `device.info` | Read device metadata (OS, screen size) |
| `device.network` | Check network connectivity |
| `device.files` | Access local filesystem (read-only unless `storage` also granted) |

**integrations** — Third-party OAuth integrations:

| Permission | What it grants |
|-----------|---------------|
| `google` | Access to Google services (Sheets, Gmail, Drive, Calendar) via user's connected Google account |
| `github` | Access to GitHub repositories, issues, and pull requests |
| `linkedin` | Access to LinkedIn profile and company data |

### Declaring Permissions

```yaml
permissions:
  resources: [storage, database]
  chat: [chat.send, chat.listen]
  integrations: [google, github]
```

Device permissions are listed under `resources`:

```yaml
permissions:
  resources: [storage, device.location, device.camera]
```

### Approval-Required Actions

For destructive or sensitive operations, declare them in `approvalRequired`. The platform will pause execution and ask the user to confirm before proceeding:

```yaml
approvalRequired: [email.delete, email.send, report.export]
```

Action names are free-form strings. Use a `noun.verb` pattern by convention. The platform presents the action name to the user in the confirmation dialog.

---

## Triggers

Triggers define when a component activates. Without triggers, a component only responds to direct user messages. With triggers, it can act autonomously on a schedule or in response to events.

All triggers are declared as an array:

```yaml
triggers:
  - kind: cron
    config: { cron: "0 9 * * 1-5" }
  - kind: event
    config: { event: "email.received" }
```

### cron

Activates on a schedule. Uses standard cron syntax (5-field, UTC).

```yaml
triggers:
  - kind: cron
    config:
      cron: "0 9 * * 1-5"   # 09:00 UTC weekdays
```

Common patterns:

| Schedule | Expression |
|----------|-----------|
| Every 15 minutes | `*/15 * * * *` |
| Every hour | `0 * * * *` |
| Daily at 08:00 UTC | `0 8 * * *` |
| Weekdays at 09:00 UTC | `0 9 * * 1-5` |
| First of every month | `0 0 1 * *` |

### webhook

Registers a webhook endpoint that external services can call. The path is appended to the platform's webhook base URL.

```yaml
triggers:
  - kind: webhook
    config:
      path: "/hooks/github-pr"
      events: ["pull_request.opened", "pull_request.synchronize"]
```

The full webhook URL will be `https://router.xaiworkspace.com/webhooks/{slug}/{path}`. Share this URL with the external service's webhook configuration.

The `events` array filters which event types activate the component. If omitted, all events to the path activate it.

### event

Listens for platform-internal events emitted by other components or system services.

```yaml
triggers:
  - kind: event
    config:
      event: "email.received"
      filter:
        label: "sales"
```

The optional `filter` object narrows which event instances activate the component. Filter keys and values are event-specific.

Common platform events:

| Event | Emitted when |
|-------|-------------|
| `email.received` | New email arrives in connected inbox |
| `file.uploaded` | User uploads a file |
| `chat.message` | User sends a message (use sparingly — fires very often) |
| `support.ticket.created` | New support ticket opened |

The `filter` on `file.uploaded` supports a `mime` array:

```yaml
- kind: event
  config:
    event: "file.uploaded"
    filter:
      mime: ["image/jpeg", "image/png", "application/pdf"]
```

The `filter` on `chat.message` supports a `contains` string:

```yaml
- kind: event
  config:
    event: "chat.message"
    filter:
      contains: "help"
```

### watch

Activates when a named field in the component's state reaches a target value.

```yaml
triggers:
  - kind: watch
    config:
      watch: "status"
      target_value: "completed"
```

This is useful for workflows where one part of an app signals readiness to another.

---

## Persona System

The persona system shapes the AI's identity and behaviour when acting as your component. It is injected into the system prompt before every interaction.

All four persona fields are optional markdown strings. Use them to give your component a consistent, predictable character.

```yaml
persona:
  soul: ...
  rules: ...
  knowledge: ...
  user: ...
```

### soul

The core identity statement. One to four sentences describing who the AI is when acting as this component. This is the most important persona field — it anchors the AI's tone, priorities, and decision-making style.

```yaml
persona:
  soul: |
    You are a patient and empathetic customer support agent. Always acknowledge
    the customer's frustration before solving the problem. Use simple language
    and avoid technical jargon unless the user demonstrates technical familiarity.
```

Write the soul in second person ("You are..."). Keep it focused — a soul that tries to define too many traits ends up defining none.

### rules

A bullet list of explicit behavioural constraints. These are things the AI must always or never do, regardless of user requests. Rules supplement the soul with specific guardrails.

```yaml
persona:
  rules: |
    - Never promise refunds without approval
    - Escalate billing disputes to a human
    - Always provide a ticket reference number
    - Respond within the user's language preference
    - Never modify past records without explicit confirmation
```

Rules are enforced by the model, not by the sandbox. For hard security boundaries, use `approvalRequired` and permissions instead.

### knowledge

Background context injected into every interaction. Use this for domain knowledge, reference data, or methodology that the AI should have available without the user having to provide it.

```yaml
persona:
  knowledge: |
    Sales methodology: MEDDIC (Metrics, Economic Buyer, Decision Criteria,
    Decision Process, Identify Pain, Champion).

    Standard deal stages: Prospect → Qualify → Demo → Proposal → Negotiation → Closed Won/Lost.

    Our pricing tiers: Starter ($49/mo), Essential ($100/mo), Professional ($300/mo).
```

Keep knowledge concise. Long knowledge fields consume tokens on every request. For large knowledge bases, use `storage` to load relevant context dynamically.

### user

Context the AI should maintain about the person it is talking to. This is typically populated dynamically at runtime, but you can provide defaults in the manifest:

```yaml
persona:
  user: |
    Preferred language: English.
    Timezone: UTC+11 (Sydney).
    Communication style: direct and brief.
```

In practice, the platform merges the manifest's `user` field with runtime user profile data. The manifest value is a fallback for onboarding before profile data is collected.

---

## Sandbox and Security

### Execution Model

All components run inside an isolated iframe sandbox. Communication between the component and the host platform occurs exclusively via a typed `postMessage` protocol — the sandbox cannot directly access the DOM, network, or filesystem outside its declared permissions.

### Sandbox Levels

| Level | What it allows |
|-------|---------------|
| `strict` | Only declared permissions; all other access blocked. Recommended for all published components. |
| `relaxed` | Declared permissions plus limited DOM access. Suitable for UI-heavy components in controlled deployments. |
| `none` | No sandboxing. Only available for first-party plugins. Not available for marketplace publishing. |

Set the level in the manifest:

```yaml
sandbox: strict
```

### Bridge Protocol

The sandbox communicates with the host via a structured postMessage protocol. You do not call this protocol directly — the platform SDK (injected into the sandbox at runtime) exposes it as an async API. The protocol is documented here for transparency.

**Sandbox to host:**

| Message type | When sent |
|-------------|----------|
| `sandbox:ready` | App has initialised and is ready to receive messages |
| `sandbox:request` | Requesting a platform action (checked against permissions) |
| `sandbox:chat.send` | Sending a message to the user chat |
| `sandbox:storage` | Key-value storage read or write |
| `sandbox:approval` | Requesting user confirmation for an `approvalRequired` action |
| `sandbox:render` | Injecting safe HTML into the host UI |

**Host to sandbox:**

| Message type | When sent |
|-------------|----------|
| `host:init` | Initialising the sandbox with config, granted permissions, and persona |
| `host:response` | Response to a sandbox request |
| `host:event` | Delivering a trigger event |
| `host:chat.message` | Incoming user message |
| `host:shutdown` | Instructing the sandbox to terminate cleanly |

### Security Boundaries

- Components cannot access other components' storage, regardless of permissions.
- The `entrypoint` field (inline JavaScript) is evaluated inside the sandbox only. It cannot import external modules or make outbound network calls outside declared permissions.
- OAuth tokens for `integrations` are held by the platform and never exposed to the component. The platform makes requests on the component's behalf and returns only the response body.
- `approvalRequired` actions cannot be bypassed by the component's own code. The host enforces the approval gate regardless of what the entrypoint does.

---

## Publishing

### From the xAI Workspace Chat

Install directly from a GitHub repository:

```
/install https://github.com/yourname/your-repo
```

Install a specific app in a monorepo:

```
/install https://github.com/yourname/your-repo/tree/main/apps/my-app
```

Install from the registry by slug:

```
/install @my-app-slug
```

### From the CLI (API)

Publish a manifest by sending its YAML content to the API:

```bash
curl -X POST https://router.xaiworkspace.com/api/mini-apps/publish \
  -H "Authorization: Bearer $YOUR_TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"manifest\": \"$(cat manifest.yml | jq -Rs .)\"}"
```

### AI-Assisted Generation

Generate a manifest from a plain-English description:

```bash
curl -X POST https://router.xaiworkspace.com/api/mini-apps/generate \
  -H "Authorization: Bearer $YOUR_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "description": "An app that monitors my GitHub notifications and summarises new PRs every morning",
    "kind": "app",
    "model": "claude-sonnet-4-6"
  }'
```

Refine a draft manifest with natural language feedback:

```bash
curl -X POST https://router.xaiworkspace.com/api/mini-apps/refine \
  -H "Authorization: Bearer $YOUR_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "yaml": "slug: my-app\nkind: app\n...",
    "feedback": "Add a cron trigger to run at 08:00 every weekday and require approval before sending any Slack messages"
  }'
```

### Monorepo Format

If your repository contains multiple apps, add `openclaw-workspace.yml` at the root:

```yaml
apps:
  - path: apps/email-manager
  - path: apps/expense-tracker
  - path: agents/sales-assistant
  - path: agents/support-bot
  - path: skills/summarize-text
  - path: skills/extract-data
  - path: tools/google-sheets
  - path: tools/github-issues
```

Installing the repository root URL installs all listed components. Installing a specific path installs only that one.

### Validation

The platform validates the manifest on publish and returns structured errors if anything is wrong:

```json
{
  "valid": false,
  "errors": [
    { "field": "slug", "message": "Must match /^[a-z0-9][a-z0-9-]{1,98}[a-z0-9]$/" },
    { "field": "permissions.resources[2]", "message": "Unknown permission: 'filesystem'" }
  ]
}
```

Fix the errors and republish. Validation is also available without publishing:

```bash
curl -X POST https://router.xaiworkspace.com/api/mini-apps/validate \
  -H "Authorization: Bearer $YOUR_TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"manifest\": \"$(cat manifest.yml | jq -Rs .)\"}"
```

---

## API Reference

All endpoints require a JWT Bearer token in the `Authorization` header.

Base URL: `https://router.xaiworkspace.com`

### Discovery

**List apps**

```
GET /api/mini-apps
```

Query parameters:
- `kind` — filter by kind: `app`, `agent`, `skill`, `tool`, `plugin`

Returns an array of app summary objects.

**Search apps**

```
GET /api/mini-apps/search?q=expense&kind=app
```

Query parameters:
- `q` — search query (name, description, slug)
- `kind` — optional kind filter

**Installed apps**

```
GET /api/mini-apps/installed
```

Returns apps installed on the authenticated user's instance.

**App details**

```
GET /api/mini-apps/:slug
```

Returns the full app record including manifest, install count, and rating.

### Lifecycle

**Install**

```
POST /api/mini-apps/:slug/install
```

Optional body:

```json
{
  "config": {
    "key": "value"
  }
}
```

The `config` object is passed to the app at initialisation. Use it for app-specific settings (API keys, preferences) that are not part of the manifest.

**Uninstall**

```
POST /api/mini-apps/:slug/uninstall
```

Removes the app from the instance and deletes its sandboxed storage.

**Stop**

```
POST /api/mini-apps/:slug/stop
```

Pauses the app (suspends triggers, keeps storage intact).

**Start**

```
POST /api/mini-apps/:slug/start
```

Resumes a stopped app.

### Publishing

**Publish from YAML**

```
POST /api/mini-apps/publish
```

Body:

```json
{
  "manifest": "<yaml string>"
}
```

**Install from GitHub**

```
POST /api/mini-apps/install-github
```

Body:

```json
{
  "url": "https://github.com/yourname/your-repo"
}
```

Supports repository root (uses `openclaw-workspace.yml` if present) or a direct path to an app directory.

**Generate manifest**

```
POST /api/mini-apps/generate
```

Body:

```json
{
  "description": "Plain English description of what you want to build",
  "kind": "app",
  "model": "claude-sonnet-4-6"
}
```

Returns a `manifest` string containing generated YAML.

**Refine manifest**

```
POST /api/mini-apps/refine
```

Body:

```json
{
  "yaml": "<existing yaml string>",
  "feedback": "Plain English description of changes you want"
}
```

Returns a `manifest` string with the updated YAML.

### Response Format

Successful responses return HTTP 200 with a JSON body. Error responses use standard HTTP status codes with a JSON error body:

```json
{
  "error": "App not found",
  "code": "NOT_FOUND"
}
```

---

## Examples

Complete, working manifests for each kind.

### Skill: summarize-text

```yaml
slug: summarize-text
kind: skill
name: Summarize Text
description: Summarizes any text into key points — emails, documents, articles, chat threads
icon: ⚡
version: 1.0.0

input:
  type: object
  properties:
    text:
      type: string
      description: The text to summarize
    maxPoints:
      type: integer
      description: Maximum number of bullet points
      default: 5
    style:
      type: string
      enum: [bullets, paragraph, tldr]
      default: bullets
  required: [text]

output:
  type: object
  properties:
    summary:
      type: string
    pointCount:
      type: integer

model: claude-haiku-4-5-20251001
sandbox: strict
```

### Skill: extract-data

```yaml
slug: extract-data
kind: skill
name: Extract Structured Data
description: Extracts structured data from unstructured text — invoices, receipts, contracts, forms
icon: 📋
version: 1.0.0

input:
  type: object
  properties:
    text:
      type: string
      description: Raw text or OCR output to extract from
    schema:
      type: object
      description: JSON Schema describing the expected output structure
    hints:
      type: string
      description: Optional hints about what to look for
  required: [text]

output:
  type: object
  properties:
    extracted:
      type: object
      description: Structured data matching the requested schema
    confidence:
      type: number
      description: Confidence score 0-1

model: claude-sonnet-4-6
sandbox: strict
```

### App: expense-tracker

```yaml
slug: expense-tracker
kind: app
name: Expense Tracker
description: Track business expenses from receipts, invoices, and bank statements. Categorize and generate reports.
icon: 💰
version: 1.0.0

persona:
  soul: You are a meticulous financial assistant. Be precise with numbers, always use the user's preferred currency.
  rules: |
    - Always confirm amounts before recording
    - Categorize expenses using standard business categories
    - Flag duplicate entries
    - Never modify past entries without approval

permissions:
  resources: [storage, database]
  chat: [chat.send, chat.read]

triggers:
  - kind: event
    config: { event: "file.uploaded", filter: { mime: ["image/jpeg", "image/png", "application/pdf"] } }

model: claude-sonnet-4-6
sandbox: strict
approvalRequired: [expense.delete, report.export]
```

### App: email-manager

```yaml
slug: email-manager
kind: app
name: Email Manager
description: Watches your inbox, archives junk, summarizes important emails, and drafts replies
icon: 📧
version: 1.0.0

persona:
  soul: You are a professional email assistant. Be concise, clear, and respect the user's communication style.
  rules: |
    - Never delete emails without explicit user approval
    - Always summarize before taking action
    - Flag emails from unknown senders
    - Preserve email threading

permissions:
  resources: [email, storage]
  chat: [chat.send, chat.listen]

triggers:
  - kind: cron
    config: { cron: "*/15 * * * *" }
  - kind: event
    config: { event: "email.received" }

model: claude-sonnet-4-6
sandbox: strict
approvalRequired: [email.delete, email.send]
```

### App: code-reviewer

```yaml
slug: code-reviewer
kind: app
name: Code Reviewer
description: Reviews pull requests, suggests improvements, checks for security issues and code quality
icon: 🔍
version: 1.0.0

persona:
  soul: You are a senior software engineer doing code review. Be constructive, specific, and educational.
  rules: |
    - Focus on bugs, security, and maintainability over style
    - Suggest concrete fixes, not vague advice
    - Acknowledge good patterns when you see them
    - Never auto-approve — always provide review notes

permissions:
  resources: [storage]
  chat: [chat.send, chat.read]
  integrations: [github]

triggers:
  - kind: webhook
    config: { path: "/hooks/github-pr", events: ["pull_request.opened", "pull_request.synchronize"] }

model: claude-sonnet-4-6
sandbox: strict
dependencies: [summarize-text]
```

### Agent: sales-assistant

```yaml
slug: sales-assistant
kind: agent
name: Sales Assistant
description: Helps manage leads, draft proposals, follow up with prospects, and track pipeline
icon: 💼
version: 1.0.0

persona:
  soul: |
    You are a friendly, professional sales assistant. You understand B2B sales cycles,
    can draft compelling proposals, and help prioritize leads by potential value.
    Always be encouraging but realistic about deal prospects.
  rules: |
    - Never share client data between different prospects
    - Always confirm before sending outbound messages
    - Track all interactions for pipeline reporting
    - Respect timezone preferences for follow-up scheduling
  knowledge: |
    Sales methodology: MEDDIC (Metrics, Economic Buyer, Decision Criteria,
    Decision Process, Identify Pain, Champion).

permissions:
  resources: [storage, database, email]
  chat: [chat.send, chat.listen]

triggers:
  - kind: cron
    config: { cron: "0 9 * * 1-5" }
  - kind: event
    config: { event: "email.received", filter: { label: "sales" } }

model: claude-sonnet-4-6
modelFallback: [claude-haiku-4-5-20251001]
sandbox: strict
approvalRequired: [email.send, proposal.send]
```

### Agent: support-bot

```yaml
slug: support-bot
kind: agent
name: Support Bot
description: Handles customer support tickets — triages, responds to common questions, escalates complex issues
icon: 🛠
version: 1.0.0

persona:
  soul: |
    You are a patient and empathetic customer support agent. Always acknowledge
    the customer's frustration before solving the problem. Use simple language.
  rules: |
    - Never promise refunds without approval
    - Escalate billing disputes to a human
    - Always provide a ticket reference number
    - Respond within the user's language preference

permissions:
  resources: [storage, database]
  chat: [chat.send, chat.listen]

triggers:
  - kind: event
    config: { event: "support.ticket.created" }
  - kind: event
    config: { event: "chat.message", filter: { contains: "help" } }

model: claude-haiku-4-5-20251001
modelFallback: [claude-sonnet-4-6]
sandbox: strict
approvalRequired: [refund.issue, account.modify]
```

### Tool: google-sheets

```yaml
slug: google-sheets
kind: tool
name: Google Sheets
description: Read, write, and manage Google Sheets spreadsheets
icon: 📊
version: 1.0.0

authProvider: google
baseUrl: https://sheets.googleapis.com/v4

operations:
  - name: list
    description: List your spreadsheets
    method: GET
    path: https://www.googleapis.com/drive/v3/files
    query:
      q: "mimeType='application/vnd.google-apps.spreadsheet'"
      fields: "files(id,name,modifiedTime,webViewLink)"
  - name: get
    description: Get spreadsheet metadata including all sheet tabs
    method: GET
    path: /spreadsheets/{spreadsheetId}
  - name: read
    description: Read data from a spreadsheet range
    method: GET
    path: /spreadsheets/{spreadsheetId}/values/{range}
  - name: write
    description: Write data to a spreadsheet range
    method: PUT
    path: /spreadsheets/{spreadsheetId}/values/{range}
  - name: append
    description: Append rows to a spreadsheet
    method: POST
    path: /spreadsheets/{spreadsheetId}/values/{range}:append
  - name: create
    description: Create a new spreadsheet
    method: POST
    path: /spreadsheets
  - name: clear
    description: Clear values from a spreadsheet range
    method: POST
    path: /spreadsheets/{spreadsheetId}/values/{range}:clear

permissions:
  integrations: [google]

sandbox: strict
```

### Tool: github-issues

```yaml
slug: github-issues
kind: tool
name: GitHub Issues
description: Create, read, update, and manage GitHub issues and labels
icon: 🐛
version: 1.0.0

authProvider: github
baseUrl: https://api.github.com

operations:
  - name: list
    description: List issues for a repository
    method: GET
    path: /repos/{owner}/{repo}/issues
  - name: create
    description: Create a new issue
    method: POST
    path: /repos/{owner}/{repo}/issues
  - name: update
    description: Update an existing issue
    method: PATCH
    path: /repos/{owner}/{repo}/issues/{issue_number}
  - name: comment
    description: Add a comment to an issue
    method: POST
    path: /repos/{owner}/{repo}/issues/{issue_number}/comments
  - name: close
    description: Close an issue
    method: PATCH
    path: /repos/{owner}/{repo}/issues/{issue_number}

permissions:
  integrations: [github]

sandbox: strict
```

---

## Additional Notes

### Slug Uniqueness

Slugs are unique within the registry. If you publish a manifest with a slug that already exists and you own it, the existing record is updated. If someone else owns the slug, the publish is rejected.

During development, prefix your slugs with your username or organisation name to avoid conflicts: `yourname-expense-tracker`.

### Versioning

The platform does not enforce semver semantics — version strings are informational only. Users are notified of version changes when you republish, but updates are not automatically applied to installed instances.

To push a breaking change, increment the major version and document migration steps in your repository's README.

### Model Selection

Choose the model that fits the task:

| Model | Best for |
|-------|---------|
| `claude-haiku-4-5-20251001` | High-frequency, low-latency tasks (summaries, classification, simple Q&A) |
| `claude-sonnet-4-6` | General-purpose apps and agents requiring reasoning and nuance |

Declare `modelFallback` for production-grade components. The platform tries the primary model first and falls back in order if it is unavailable or rate-limited.

### Testing Locally

You cannot run the sandbox locally, but you can validate your manifest and test the AI behaviour by calling the API directly with your token:

```bash
# Validate manifest without publishing
curl -X POST https://router.xaiworkspace.com/api/mini-apps/validate \
  -H "Authorization: Bearer $YOUR_TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"manifest\": \"$(cat manifest.yml | jq -Rs .)\"}"
```

For skills, you can test the input/output contract by installing the skill and calling it from the chat:

```
call summarize-text text="Your test content here" style=bullets
```
