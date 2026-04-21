# xAI Workspace Mini Apps SDK

A reference guide for developers building apps, agents, skills, tools, and plugins on the xAI Workspace platform.

---

## Table of Contents

1. [Overview](#overview)
2. [Quick Start](#quick-start)
3. [Trust tiers](#trust-tiers)
4. [Developing a system mini-app](#developing-a-system-mini-app)
5. [Manifest Reference](#manifest-reference)
6. [App Kinds](#app-kinds)
7. [Permissions](#permissions)
8. [Triggers](#triggers)
9. [Persona System](#persona-system)
10. [Sandbox and Security](#sandbox-and-security)
11. [Publishing](#publishing)
12. [API Reference](#api-reference)
13. [Examples](#examples)

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

## Trust tiers

Every mini-app runs in one of two **trust tiers**, declared by the `trust` field on the manifest. The tier determines how the app is loaded, where it runs, which permission strings are honoured, and whether an end user can uninstall it.

| Tier | Default? | Rendered as | Source | Installable by user? | Can declare `system.*` permissions? |
|------|----------|-------------|--------|----------------------|--------------------------------------|
| `user` | Yes | Iframe sandbox (`SandboxFrameComponent`) | Any GitHub repo, installed via `/install` or the marketplace | Yes — can be installed and uninstalled freely | No — `system.*` strings are parsed but ignored at runtime |
| `system` | No | Native Angular standalone component in the host app | In-tree, bundled with the frontend build | No — always present, cannot be uninstalled | Yes — declared in the manifest and (in M1) runtime-enforced |

### User tier (default)

User-tier apps are what the SDK has shipped since day one. They live in external repositories, are downloaded on install, run inside a locked-down iframe sandbox, and talk to the host via the `xai.*` bridge API. Every `xai.*` call is checked against the declared `permissions` block before the sandbox bridge forwards it. `trust: 'user'` is the default — omitting the field is equivalent to setting it.

User-tier apps are the right choice for anything you want to ship, share, or install per-user. Virtually all examples in this SDK are user-tier.

### System tier

System-tier apps are first-party UI surfaces that the host app needs to ship as part of its own build — think App Manager, Instance Manager, Agent Studio. They are not sandboxed: they are ordinary Angular standalone components rendered directly by the mini-app shell, and they can inject any service the frontend already provides.

Because system-tier rendering bypasses the sandbox entirely, system apps are subject to strict source constraints:

- **In-tree only (M0).** System mini-apps must live under `xaiworkspace-frontend/src/app/system-mini-apps/<slug>/` and be registered in the frontend's `SYSTEM_MINI_APPS` array. Out-of-tree system apps are **not supported** in M0.
- **No install/uninstall lifecycle.** System apps are seeded into the registry at bootstrap via an `APP_INITIALIZER`. They appear in the same `installed()` signal as user apps (projected into the `AppInstall` shape with a synthetic `install_id` of `system:<identifier>`), but they cannot be removed by users and are not stored in the router database.
- **Trust is implicit.** In M0 there is no cryptographic verification — trust is granted by virtue of the app existing in the frontend source tree and passing code review. The manifest parser accepts `trust: 'system'` without a signature check and emits a warning to the backend log.

Forward-looking: **M1.1** will add Ed25519 signature verification for out-of-tree system mini-apps, so customers can ship their own system-tier pages (typically their own dashboard or back-office surfaces) by uploading a signed bundle. Until that ships, treat `trust: 'system'` as "only the xAI Workspace frontend team can add these".

---

## Developing a system mini-app

This section is for the frontend / core-team developer adding a new system mini-app to the `xaiworkspace-frontend` repo. If you are building a third-party app, skip to the Manifest Reference below — you want `trust: 'user'` (the default) and everything else in this SDK applies as written.

### Step-by-step

1. **Create the directory.** Everything for the mini-app lives in `xaiworkspace-frontend/src/app/system-mini-apps/<slug>/`. Pick a kebab-case slug; it will also be used for `@mention` routing.

2. **Write the Angular component.** Create `<slug>.component.ts` as a standalone Angular component. Follow the usual frontend conventions (signals, `inject()`, `@if` / `@for` control flow, SCSS with CSS custom properties). The component is loaded via `ManifestBridgeService`, which constructs a `ServiceDescriptor` from the definition and renders it inside `ServiceHostComponent` — there is no iframe, so you can import services, router, auth, `ChatService`, etc. freely.

3. **Write the manifest.** Create `manifest.ts` in the same directory and export a `SystemMiniAppDefinition`. The shape mirrors the user-tier manifest but is a TypeScript object (not YAML), and it bundles the component class alongside the metadata:

   ```ts
   // xaiworkspace-frontend/src/app/system-mini-apps/my-service/manifest.ts
   import type { SystemMiniAppDefinition } from '../../mini-apps/mini-app.types';
   import { MyServiceComponent } from './my-service.component';

   export const MY_SERVICE: SystemMiniAppDefinition = {
     identifier: 'com.xaiworkspace.my-service',
     slug: 'my-service',
     name: 'My Service',
     description: 'Short description shown in the service selector and App Manager.',
     icon: 'wrench',
     version: '0.1.0',
     kind: 'app',
     manifest: {
       trust: 'system',
       // Declare as a shell service so it appears in the topbar service selector.
       service: { order: 200 },
       // Optional: declare system.* permissions for documentation.
       // These are not runtime-enforced in M0 — see the permission matrix.
       permissions: {
         // @ts-expect-error — system.* strings are documentary in M0.
         system: ['system.instances.read'],
       },
     },
     component: MyServiceComponent,
   };
   ```

4. **Register the app.** Add the export to `xaiworkspace-frontend/src/app/system-mini-apps/index.ts` by appending it to the `SYSTEM_MINI_APPS` array:

   ```ts
   import { INFRASTRUCTURE_MINI_APP } from './infrastructure/manifest';
   import { APP_MANAGER_MINI_APP } from './app-manager/manifest';
   import { MY_SERVICE } from './my-service/manifest';

   export const SYSTEM_MINI_APPS: SystemMiniAppDefinition[] = [
     INFRASTRUCTURE_MINI_APP,
     APP_MANAGER_MINI_APP,
     MY_SERVICE,
   ];
   ```

   The `appConfig` already wires a `provideAppInitializer` that iterates `SYSTEM_MINI_APPS` and calls `MiniAppRegistryService.registerSystemMiniApp(def)` for each entry at bootstrap — you do not need to touch `app.config.ts`.

5. **Rebuild the frontend.** Run `pnpm build` (or `pnpm start` in dev). On next bootstrap the mini-app appears in the combined `installed()` list and — if the manifest declares `service: {...}` — in the topbar service selector. The Infrastructure system mini-app under `src/app/system-mini-apps/infrastructure/` is the minimal reference implementation — its `manifest.ts` is intentionally small and covers the common case (service registration, trust tier, permissions). Copy its shape for the fastest start:

   ```ts
   // src/app/system-mini-apps/infrastructure/manifest.ts (skeleton)
   export const INFRASTRUCTURE_MINI_APP: SystemMiniAppDefinition = {
     identifier: 'com.xaiworkspace.infrastructure',
     slug: 'infrastructure',
     name: 'Infrastructure',
     description: 'Manage workers, bridges, and cloud providers',
     icon: '🖥️',
     version: '1.0.0',
     kind: 'app',
     manifest: {
       trust: 'system',
       permissions: { resources: ['instances.read', 'instances.write'] },
       service: { order: 90 },
     },
     component: InstancesServiceComponent,
   };
   ```

### Runtime expectations

- System mini-apps participate in the same `@mention` flow as user apps (`@<slug>` routes to the component via `ManifestBridgeService`).
- They should **not** call the `xai.*` sandbox bridge — that API only exists inside iframes. Use normal Angular DI (`inject(ChatService)`, `inject(MiniAppRegistryService)`, etc.) instead.
- They inherit the host app's auth state, theme, i18n locale, and routing. CSS custom properties from the active brand palette are in scope.
- Because rendering happens inside the frontend bundle, a buggy system mini-app will crash the host shell. Test it the same way you would any other first-party page.

---

## Manifest Reference

Every manifest is a YAML file named `manifest.yml` at the root of the app directory.

### Core Fields

These fields apply to all five kinds.

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `slug` | string | Yes | — | Unique identifier. Kebab-case, 3–100 characters. Pattern: `/^[a-z0-9][a-z0-9-]{1,98}[a-z0-9]$/` |
| `kind` | string | Yes | — | One of: `app`, `agent`, `skill`, `tool`, `plugin`, `mcp` |
| `name` | string | Yes | — | Human-readable display name. Max 200 characters |
| `description` | string | Yes | — | What the component does. Shown in the marketplace |
| `icon` | string | No | Varies by kind | Emoji icon. Defaults: app=📦, agent=🤖, skill=⚡, tool=🔧, plugin=🔌 |
| `version` | string | No | `0.1.0` | Semantic version (e.g. `1.2.3`) |
| `model` | string | No | Platform default | Preferred AI model (e.g. `claude-sonnet-4-6`, `claude-haiku-4-5-20251001`) |
| `modelFallback` | array | No | — | Ordered list of fallback models if the preferred model is unavailable |
| `sandbox` | string | No | `strict` | Execution isolation level: `strict`, `relaxed`, or `none` |
| `identifier` | string | No | — | Reverse-domain identifier (e.g. `com.xshopper.my-app`). Used for registry uniqueness. |
| `categories` | array | No | — | Marketplace category tags (e.g. `[productivity, communication]`) |
| `trust` | string | No | `user` | Trust tier this app runs in: `user` (iframe-sandboxed, default) or `system` (native component, in-tree only). See the "Trust tiers" section. |

### Optional Fields

| Field | Type | Description |
|-------|------|-------------|
| `permissions` | object | Declared resource, chat, and integration access |
| `triggers` | array | Events or schedules that activate the component |
| `persona` | object | Personality, rules, and knowledge injected into the system prompt |
| `parameters` | array | Install-time user-supplied values (see "Manifest parameters" below). Surfaced to the user via the install dialog and injected into the running app via the `APP_PARAMETERS` env var |
| `approvalRequired` | array | Action names that require explicit user confirmation before execution |
| `dependencies` | array | Slugs of skills or tools this component requires |
| `entrypoint` | string | Inline JavaScript executed inside the sandbox for programmatic components |
| `ui` | object | UI panel configuration. When present, the platform renders the app in a side panel alongside chat |
| `startup` | string | Shell command to run the app on worker boot. Registered as a pm2 process by the openclaw ecosystem generator. Blocked chars: `$`, `;`, `\|`, `` ` ``, `>`, `<` (standalone `&` blocked, `&&` allowed). Max 500 chars |
| `cleanup` | string | Shell command to stop/remove the app's processes (run on uninstall or app stop). Max 500 chars |
| `port` | integer | Network port the app listens on. Conflicts checked against other apps. Reserved port: 19001. Ports below 1025 are also rejected (PORT_MIN). Sets `APP_PORT` env var |
| `configurable` | boolean | Whether the app has user-editable configuration |
| `singleton` | boolean | When `true`, only one install per instance is allowed. Use for infrastructure services that bind a fixed port |
| `authProvider` | string | OAuth provider name for MCP servers (lowercase alphanumeric). Router injects OAuth tokens per-call |
| `commands` | object | Map of command names to shell commands. Keys must be valid identifiers (`/^[a-zA-Z_][a-zA-Z0-9_-]*$/`, kebab-case allowed). Values are shell command strings; use `{args}` as a placeholder for user-provided arguments. Commands are executed directly by the platform (manifest-driven exec, no AI model needed) |
| `help` | string | Multi-line Markdown help text shown when the user types `@<slug> help`. Document available commands and usage examples here |

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

## Manifest parameters

Apps and agents can declare install-time parameters that the user fills in via the install dialog. The platform validates the values against the declared schema, persists them on the install record, and injects them into the running process as the `APP_PARAMETERS` environment variable (see "Runtime environment" below).

The `parameters` field is an array of parameter objects. Each parameter uses a JSON Schema subset.

**Allowed `type` values:**

| `type` | Description |
|--------|-------------|
| `string` | Free-form text. Optionally constrained by `pattern`, `enum`, `min`, `max` (length) |
| `number` | Numeric value. Optionally constrained by `min`, `max` |
| `boolean` | True or false. Rendered as a checkbox |
| `select` | Single choice from `enum`. Rendered as a dropdown |
| `password` | Sensitive text. Masked in the UI but stored on the install record |
| `secret` | Sensitive text. Masked in the UI **and** never stored on the install record — kept only in the secrets vault and surfaced via `OC_SECRET_HOST`. Use this for API keys and tokens |

**Schema fields:**

| Field | Type | Description |
|-------|------|-------------|
| `name` | string | Parameter identifier. Used as the key in `APP_PARAMETERS`. Required. Must match `/^[a-zA-Z_][a-zA-Z0-9_]*$/` |
| `label` | string | Human-readable label shown in the install dialog. Defaults to `name` |
| `type` | string | One of the allowed types above. Required |
| `description` | string | Help text shown under the field in the install dialog |
| `required` | boolean | If `true`, the user must provide a value to install. Default `false` |
| `default` | any | Default value. Type must match `type`. Used as the initial dialog value |
| `enum` | array | List of allowed values. Required for `type: select`. Each entry may be a primitive or `{ value, label }` |
| `pattern` | string | Regex (ECMAScript syntax) the value must match. Only applies to `type: string` and `type: password` |
| `min` | number | For `type: number`: minimum value (inclusive). For `type: string`/`password`: minimum length |
| `max` | number | For `type: number`: maximum value (inclusive). For `type: string`/`password`: maximum length |

Validation runs **at manifest publish time** (rejecting malformed schemas) **and at install time** (rejecting user input that fails the schema). The running app can trust that values in `APP_PARAMETERS` already conform to the declared schema.

**Example: string with pattern**

```yaml
parameters:
  - name: subdomain
    label: Public subdomain
    type: string
    required: true
    pattern: "^[a-z][a-z0-9-]{2,30}$"
    description: Lowercase letters, digits, and hyphens. 3–31 characters.
```

**Example: select with enum and default**

```yaml
parameters:
  - name: model
    label: Default model
    type: select
    default: claude-sonnet-4-6
    enum:
      - { value: claude-haiku-4-5-20251001, label: Haiku (Fast) }
      - { value: claude-sonnet-4-6, label: Sonnet (Balanced) }
      - { value: claude-opus-4-6, label: Opus (Best) }
```

**Example: number with min and max**

```yaml
parameters:
  - name: pollIntervalSeconds
    label: Poll interval (seconds)
    type: number
    default: 60
    min: 5
    max: 3600
    description: How often to check the upstream feed.
```

---

## Runtime environment

When the bridge spawns a mini-app process (via pm2), it injects a fixed set of environment variables. These are the only env vars the SDK guarantees — additional values must come from the `APP_PARAMETERS` JSON.

This list is **frozen for SDK v1**. Adding or renaming a variable requires a major SDK version bump.

| Variable | Type | Example | Description | Always present? |
|----------|------|---------|-------------|-----------------|
| `APP_PORT` | number | `4001` | TCP port the app should listen on if it serves HTTP/WS. Set from `manifest.port` | Only if the manifest declares `port` |
| `APP_INSTANCE_NAME` | string | `alice` | The user-chosen instance name. For default (parameterless) installs the value is `default` | Always |
| `APP_PARAMETERS` | JSON string | `{"persona":"PM","model":"sonnet"}` | Install-time parameter values, JSON-encoded. Empty object `{}` if the manifest declares no parameters | Always |
| `APP_IDENTIFIER` | string | `com.xshopper.agent` | The reverse-domain identifier from `manifest.identifier` | Always |
| `APP_DATA_DIR` | path | `/data/com.xshopper.agent/alice` | Sandboxed per-instance data directory. The bridge creates it before launch and the app may read/write freely inside it | Always |
| `BRIDGE_URL` | URL | `http://127.0.0.1:19099` | Local bridge HTTP base. Use this to call `POST /api/messages` to send chat messages, or any other bridge-local endpoint | Always |
| `WORKER_ID` | string | `w_xyz123` | The worker identifier the bridge is registered as on the router | Always |
| `DOMAIN` | string | `xaiworkspace.com` | The domain the user is operating under (relevant for white-label deployments) | Always (may be empty string in legacy installs) |
| `USER_ID` | string | `cognito-sub-uuid` | The Cognito sub of the user that installed the app | Always |
| `OC_SECRET_HOST` | URL | `http://127.0.0.1:19099/api/secrets` | Endpoint for fetching values declared as `type: secret` parameters. Apps must fetch secrets at runtime from this URL — secrets are never inlined into `APP_PARAMETERS` | Always |
| `APP_BRIDGE_TOKEN` | string (hex) | `3f7a…` | Per-install HMAC token. Apps MUST present this as the `X-App-Bridge-Token` header when calling `POST /api/agent-message`. The bridge generates a fresh 32-byte token per install/upgrade and compares with `timingSafeEqual`. Never log, persist, or forward this value to other apps | Always |
| `APP_CALLBACK_TOKEN` | string (hex) | `b8e1…` | Per-install token issued by the router for posting installation callback events to `POST /api/app-callback/:slug/installed`, `/progress`, `/failed`. Apps MUST send it as the `X-App-Callback-Token` header. The router validates with `timingSafeEqual` against `oc_app_installs.callback_token`. Never log, persist, or forward this value | Always |

**Notes:**

- Do **not** assume any other env var is present. The host shell may leak unrelated variables, but the SDK contract covers only the list above.
- The set is frozen for v1. Future additions live behind feature negotiation or a new SDK major version.
- For local development outside a bridge, set these manually (e.g. via a `.env` file) so your app behaves the same way it will in production.

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
identifier: com.xshopper.expense-tracker

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
modelFallback: [claude-haiku-4-5-20251001]
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
modelFallback: [claude-sonnet-4-6]
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

### MCP Server

An MCP (Model Context Protocol) server is a mini app that advertises tools to the LLM natively via LiteLLM. MCP servers are stateless — OAuth tokens are injected per-call by the router from the database.

Use MCP servers when:
- You want to expose external API capabilities as LLM tools
- You need authenticated access to a third-party service (tokens managed by the platform)
- You want LiteLLM to handle tool discovery, execution, and spend tracking

```yaml
slug: mcp-postgres
kind: mcp
name: PostgreSQL MCP
description: Query and manage PostgreSQL databases via MCP tools
icon: 🐘
version: 1.0.0
port: 5100
startup: "node server.js"
authProvider: postgres

permissions:
  network: [localhost:5100]

model: claude-sonnet-4-6
sandbox: strict
```

MCP servers require a `port` field. The `authProvider` field (optional) links to an OAuth connection — the router injects the token via `X-OAuth-Token` header on each tool call. Registration with LiteLLM happens automatically on install; deregistration on uninstall, instance stop, and GDPR delete.

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

**network** — HTTP access for sandbox apps:

| Permission | What it grants |
|-----------|---------------|
| `localhost:PORT` | Allow `xai.http()` calls to `http://localhost:PORT`. The host proxies the request. |

Example:
```yaml
permissions:
  network: [localhost:4001]
```

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
| `sandbox:http` | Proxied HTTP request (requires `permissions.network` declaration) |

**Slug tagging requirement (Batch D #D7):** Every `sandbox:*` message except the bootstrap `sandbox:ready` must include a `slug` field matching the app's own slug. The host instance drops messages whose declared `slug` does not match the instance it was initialised for, as a defence against cross-iframe impersonation. The SDK shim learns the authoritative slug from `host:init.appSlug` and tags all outbound messages automatically — if you craft `postMessage` calls by hand, you are responsible for including it.

**Host to sandbox:**

| Message type | When sent |
|-------------|----------|
| `host:init` | Initialising the sandbox with config, granted permissions, and persona |
| `host:response` | Response to a sandbox request |
| `host:event` | Delivering a trigger event |
| `host:chat.message` | Incoming user message |
| `host:shutdown` | Instructing the sandbox to terminate cleanly |

**Router-relayed approval flow** (used by mini-apps running on the bridge, not in-page sandboxes):

| WS message | Direction | Payload | Description |
|------------|-----------|---------|-------------|
| `approval_request` | router → frontend | `{ request_id, app_identifier, title, description, danger_level, timeout_ms }` | App is requesting user confirmation. Frontend opens an inline modal in the chat area with the title, description, danger badge and a countdown timer. While the modal is open, user input in the chat textbox is queued. |
| `approval_response` | frontend → router | `{ request_id, result: 'approved' \| 'denied' \| 'timeout' }` | Sent when the user clicks Approve, clicks Deny, or the timeout (default 60 seconds) elapses. The router forwards the result back to the originating mini-app, which receives it via `xai.on('approval', handler)`. |

`danger_level` is one of `low`, `medium`, `high` — controls the badge colour on the modal. `timeout_ms` defaults to 60000 (60 seconds) if omitted; on timeout the response is auto-`denied` with `result: 'timeout'`.

App-side example:

```javascript
const result = await new Promise((resolve) => {
  xai.on('approval', (msg) => {
    if (msg.request_id === myRequestId) resolve(msg.result);
  });
  xai.requestApproval('email.send', 'Send 14 outbound emails to leads in pipeline?');
});
// result === 'approved' | 'denied' | 'timeout'
```

### SDK API Reference

The platform SDK is injected as `window.xai` into every sandbox iframe. Key methods:

| Method | Description |
|--------|-------------|
| `xai.render(html)` | Replace `#app` innerHTML with the given HTML string |
| `xai.http(url, options?)` | Proxied HTTP request. Options: `{ method, headers, body }`. Returns `Promise<{ status, data }>`. Requires `permissions.network` |
| `xai.storage.get(key)` | Read a value from app-scoped storage |
| `xai.storage.set(key, value)` | Write a value to app-scoped storage |
| `xai.storage.delete(key)` | Delete a key from storage |
| `xai.storage.list(prefix?)` | List storage entries matching a prefix |
| `xai.chat.send(text, buttons?)` | Send a chat message with optional button rows |
| `xai.on(event, handler)` | Listen for events: `ready`, `chat.message`, `shutdown`, `trigger.*`, `approval` |
| `xai.request(action, data)` | Generic permission-scoped platform request |
| `xai.requestApproval(action, desc)` | Request user confirmation. Returns `Promise<'approved' \| 'denied' \| 'timeout'>`. The `approval` event also fires with the same result so apps can use `xai.on('approval', handler)` for fire-and-forget flows. |
| `xai.tools.execute(slug, op, params?)` | Execute an installed tool operation |
| `xai.tools.list()` | List available tools |
| `xai.memory.get(cat, key)` | Read from persistent memory |
| `xai.memory.set(cat, key, value, opts?)` | Write to persistent memory |
| `xai.memory.search(query)` | Search memory |
| `xai.log(msg, data?)` | Log a message (forwarded to host) |

**`xai.http()` example:**

```javascript
// Requires: permissions.network: [localhost:4001]
const res = await xai.http('http://localhost:4001/v1/models');
console.log(res.data); // { data: [{ id: 'grok-3', ... }] }

const postRes = await xai.http('http://localhost:4001/admin/token', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ access_token: 'sk-ant-...' })
});
```

### UI Panel

Apps can declare a `ui` field in their manifest to render a custom interface in a side panel alongside the chat. When present, the platform loads the app's sandbox iframe in the right panel instead of inline.

```yaml
ui:
  type: panel    # Currently the only type; renders as a right-side panel
  title: My App  # Panel header title
```

The app uses `xai.render(html)` inside its `entrypoint` to control what appears in the panel. The entrypoint is standard inline JavaScript (or compiled from TypeScript). All SDK methods (`xai.http()`, `xai.storage`, `xai.chat`, etc.) are available.

**Example: minimal panel app**

```yaml
slug: my-panel-app
kind: app
name: My Panel App
ui:
  type: panel
  title: Dashboard
permissions:
  chat: [chat.send]
sandbox: relaxed
entrypoint: |
  xai.on('ready', () => {
    xai.render('<h1>Hello from the panel!</h1>');
  });
```

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
identifier: com.xshopper.summarize-text

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
identifier: com.xshopper.extract-data

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
modelFallback: [claude-haiku-4-5-20251001]
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
identifier: com.xshopper.expense-tracker

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
modelFallback: [claude-haiku-4-5-20251001]
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
identifier: com.xshopper.email-manager

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
modelFallback: [claude-haiku-4-5-20251001]
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
identifier: com.xshopper.code-reviewer

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
modelFallback: [claude-opus-4-6]
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
identifier: com.xshopper.sales-assistant

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
identifier: com.xshopper.support-bot

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
identifier: com.xshopper.google-sheets

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
identifier: com.xshopper.github-issues

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

### E2E Testing with done24bot

For full end-to-end testing against a live xAI Workspace instance, use [done24bot.com](https://done24bot.com) as a remote browser backend with Jest + Puppeteer.

**Setup:**

```bash
npm install --save-dev puppeteer-core jest ts-jest @types/jest
```

**jest.config.js:**

```javascript
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  testMatch: ['<rootDir>/e2e/**/*.spec.ts'],
  testTimeout: 120_000,
  maxWorkers: 1,
};
```

**e2e/helpers.ts** (connects to done24bot, logs in, sends messages):

```typescript
import puppeteer, { Browser, Page } from 'puppeteer-core';

// Fetch the real WebSocket URL (CloudFront does NOT proxy WebSocket)
async function getWsUrl(): Promise<string> {
  const res = await fetch('https://done24bot.com/done24bot_outputs.json');
  const config: any = await res.json();
  const ws = config.custom.WEBSOCKET_API;
  return `${ws.endpoint}/${ws.stageName}`;
}

export async function setup(): Promise<Page> {
  const wsUrl = await getWsUrl();
  const browser = await puppeteer.connect({
    browserWSEndpoint: `${wsUrl}?apiKey=${process.env.D24_API_KEY}`,
    protocolTimeout: 120_000,
  });
  const page = await browser.newPage();
  await page.goto('https://xaiworkspace.com', { waitUntil: 'networkidle2', timeout: 60_000 });
  // Login if needed, then return page
  return page;
}
```

**Key considerations:**
- Use `page.evaluate()` for all DOM interaction (Puppeteer's `page.type()` is extremely slow over the WebSocket relay)
- Set `protocolTimeout: 120_000` (default 30s is too low for the relay)
- Always call `browser.disconnect()` (not `browser.close()`) — close would shut down the remote Chrome
- The done24bot Chrome extension must be running and connected before tests start

**Running tests:**

```bash
D24_API_KEY=your_key npm test
```

---

## Permission matrix

This section is the authoritative reference for every permission string a mini-app can declare in its `manifest.yml`. The earlier "Permissions" section above gives the high-level groups; this matrix documents exactly what each permission grants, which component enforces it, and what gotchas apply.

Permissions are split into six categories: **chat**, **resources**, **device**, **integrations**, **network**, and **system**. Only the permissions listed below are accepted by the manifest parser (`xaiworkspace-backend/src/manifest-parser.js → VALID_PERMISSIONS`). Unknown permission strings are rejected at install time with a validation error — see "Rejection behaviour" at the bottom of this section.

### Matrix

| Permission | Category | Grants | Enforced by | Notes |
|-----------|----------|--------|-------------|-------|
| `chat.send` | chat | App may post messages into the user's chat via the sandbox bridge (`xai.chat.send()` / WS `type: send_message`) | Router WS gateway, sandbox bridge | Messages are attributed to the app, not the user. Counts against the user's rate limit. |
| `chat.read` | chat | App may read the current session's message history via `xai.chat.history()` | Router WS gateway | Only the active session; cross-session reads require `chat.listen` + explicit session targeting. |
| `chat.listen` | chat | App receives a real-time stream of every inbound user message on the session | Router WS gateway, workspace gateway | Required for passive agents (e.g. `support-bot`, `email-manager`). Sent as `mirror`-style events. |
| `tool.execute` | chat | App may invoke any installed tool (e.g. `@github.createIssue`) via `xai.tools.call()` | Workspace gateway tool router | Subject to the called tool's own OAuth/permission check. |
| `tool.list` | chat | App may enumerate the list of installed tools and their manifests | Workspace gateway | Read-only; does not imply `tool.execute`. |
| `memory.read` | chat | App may read from the user's long-term AI memory store | Workspace memory store | Scoped to the current user; cannot read other users' memory. |
| `memory.write` | chat | App may write to the user's long-term AI memory store | Workspace memory store | Writes are tagged with the app's slug for attribution/audit. |
| `storage` | resources | Key-value storage scoped to `{app_domain, chat_id, table_name='__kv__'}` via `xai.storage.set/get()` | Router `DataService` (`/api/data/:appDomain/:table`), Postgres `oc_app_data` JSONB | Isolated per app — one app cannot read another app's storage regardless of permissions. |
| `email` | resources | App may read and send email via the user's connected email account (Gmail/Outlook via OAuth) | Router OAuth connector registry, workspace email plugin | Requires the user to have connected an email provider first (`@connect gmail`). `email.send` should be listed in `approvalRequired` for high-risk flows. |
| `database` | resources | Structured (tabled) data persistence via `xai.db.query/insert/update()` — row-level schema, not plain KV | Router `DataService` (`/api/data/:appDomain/:table`), Postgres `oc_app_data` JSONB tables | Same backing store as `storage`, but exposes the table-level API. Per-app isolation is enforced by `app_domain` column filter. |
| `functions` | resources | App may invoke serverless functions registered on the workspace instance | Workspace function runner | Intended for heavy compute (image processing, PDF generation). Functions run in a separate pm2 process. |
| `instance_files` | resources | App may read files from the workspace instance's shared filesystem (used by `file-viewer`) | Router `container-files` route, bridge → instance file proxy | Read-only. Currently limited to the workspace instance root; path traversal is blocked by the router. |
| `device.camera` | device | Native camera access via Capacitor `@capacitor/camera` | Frontend Capacitor plugin, OS permission prompt | Triggers an OS-level consent dialog on first use. Mobile only; no-op on web. |
| `device.location` | device | GPS / IP-based geolocation via Capacitor `@capacitor/geolocation` | Frontend Capacitor plugin, OS permission prompt | Triggers an OS consent dialog. Accuracy depends on device. |
| `device.clipboard` | device | Read/write the system clipboard via `@capacitor/clipboard`. **Also required** for the host-frame shortcut `xai.clipboard.write()` (sandbox action `clipboard.write`) introduced in Batch D #D8 — previously that path bypassed the permission check. | Frontend Capacitor plugin, `SandboxBridgeService.clipboard.write` | No OS prompt on most platforms — consider this a trusted capability. |
| `device.share` | device | Trigger the native share sheet via `@capacitor/share` | Frontend Capacitor plugin | No user data granted; just UI capability. |
| `device.info` | device | Read device metadata (OS, version, model, screen size) via `@capacitor/device` | Frontend Capacitor plugin | No OS prompt; treated as low-sensitivity. |
| `device.network` | device | Read network connectivity state via `@capacitor/network` | Frontend Capacitor plugin | Read-only (online/offline, connection type). |
| `device.files` | device | Access local filesystem via `@capacitor/filesystem`. **Also required** for `xai.browser.download()` (sandbox action `browser.download`) introduced in Batch D #D8 — previously any app could trigger a browser download prompt without declaring a permission. | Frontend Capacitor plugin, scoped sandbox directory, `SandboxBridgeService.browser.download` | Read-only unless `storage` is also declared. Restricted to the app's sandbox directory — cannot escape to user's broader filesystem. |
| `integrations.google` | integrations | Reserved. Access to the user's connected Google account (Sheets, Gmail, Drive, Calendar) | Router OAuth connector registry (`oauth-connectors.js`), per-tool scopes | **Not listed in `VALID_PERMISSIONS`** — declaring it today causes a manifest validation error. OAuth integrations are currently exposed via the `@connect` mini-app rather than declared permissions; this row documents the intended future shape. |
| `integrations.github` | integrations | Reserved. Access to the user's connected GitHub account (repos, issues, PRs) | Router OAuth connector registry | **Not listed in `VALID_PERMISSIONS`** — declaring it today causes a manifest validation error. Same status as `integrations.google`. |
| `integrations.linkedin` | integrations | Reserved. Access to the user's connected LinkedIn account (profile, company data) | Router OAuth connector registry | **Not listed in `VALID_PERMISSIONS`**. Same status as `integrations.google`. |
| `integrations.slack` | integrations | Reserved. Access to the user's connected Slack workspace(s) | Router OAuth connector registry | **Not yet listed in `VALID_PERMISSIONS`** — reserved for a future sprint. Declaring this today causes a manifest validation error. |
| `integrations.stripe` | integrations | Reserved. Access to the user's connected Stripe account | Router OAuth connector registry | Reserved, same status as `slack`. |
| `integrations.notion` | integrations | Reserved. Access to the user's connected Notion workspace | Router OAuth connector registry | Reserved, same status as `slack`. |
| `integrations.microsoft` | integrations | Reserved. Access to the user's connected Microsoft 365 account (Outlook, OneDrive, Teams) | Router OAuth connector registry | Reserved, same status as `slack`. |

> **Today's OAuth story.** None of the `integrations.*` strings above appear in `manifest-parser.js VALID_PERMISSIONS` — the currently-accepted permission set is `storage`, `email`, `database`, `functions`, `chat.send`, `chat.read`, `chat.listen`, `tool.execute`, `tool.list`, `memory.read`, `memory.write`, and the `device.*` family. Third-party OAuth access (Google, GitHub, LinkedIn, Slack, Stripe, Notion, Microsoft) is exposed to mini-apps **via the `@connect` mini-app**: the user runs `@connect google` once, the token is stored in the router connector registry, and any app calling `xai.tools.call('google.sheets.append', ...)` reuses that token. The permission matrix rows are kept here as a forward-looking contract for when per-permission scoping lands.
| `network.localhost:<PORT>` | network | Allows `xai.http()` to proxy HTTP requests to `http://localhost:<PORT>` on the workspace instance. Router resolves the instance IP server-side and forwards the request. | Router `sandbox-proxy.js` (`POST /api/sandbox-proxy`), port whitelist derived from this manifest field | Multiple entries allowed (`network: [localhost:4001, localhost:3470]`). Only the loopback hostnames `localhost`, `::1`, and `127.0.0.0/8` are accepted — any other hostname is rejected with 403. Port **must** match exactly; there is no port range syntax. |
| `network.<hostname>` | network | Reserved for future support of outbound egress to a specific external host | Router sandbox proxy | **Not yet implemented.** Only `localhost:<PORT>` form is accepted today. Exact-match hostnames may be added in a future version; no wildcard (`*.example.com`) support is planned. |
| `system.instances.read` | system | App may list the user's workspace instances, their status, and metadata | **M0:** Implicit — system mini-apps access services via direct Angular DI. Permission strings are documentary. **M1 (forward):** Runtime-enforced via a capability proxy layer (deferred). | **System-trust only.** `trust: 'system'` is required for the string to be meaningful; on `trust: 'user'` apps the parser accepts it but runtime calls go nowhere. |
| `system.instances.write` | system | App may start, stop, restart, or delete workspace instances on behalf of the user | **M0:** Implicit — system mini-apps access services via direct Angular DI. Permission strings are documentary. **M1 (forward):** Runtime-enforced via a capability proxy layer (deferred). | System-trust only. Used by the in-tree Instance Manager system mini-app. |
| `system.apps.read` | system | App may list all installed mini-apps across all of the user's instances | **M0:** Implicit — system mini-apps access services via direct Angular DI. Permission strings are documentary. **M1 (forward):** Runtime-enforced via a capability proxy layer (deferred). | System-trust only. |
| `system.apps.write` | system | App may install, uninstall, or update other mini-apps | **M0:** Implicit — system mini-apps access services via direct Angular DI. Permission strings are documentary. **M1 (forward):** Runtime-enforced via a capability proxy layer (deferred). | System-trust only. The install confirmation UI is bypassed for system-trust callers — be extremely cautious with how this is exposed. |

### Declaring permissions in the manifest

Permissions live under a top-level `permissions` key, grouped by category. The parser only inspects the `resources` array strictly (every entry must be in `VALID_PERMISSIONS`); other categories are structurally validated but individual values are looser.

```yaml
name: expense-tracker
kind: app
version: 1.0.0

permissions:
  resources: [storage, database]          # storage + tabled persistence
  chat: [chat.send, chat.read]            # post + read history
  network: [localhost:3472]               # sandbox HTTP proxy to app port 3472
```

> Note: don't declare `integrations: [google]` (or any other `integrations.*`) today — the manifest parser accepts but ignores it at runtime; the permission has no enforcement. Use the `@connect` mini-app flow instead (see the note below the permission matrix).

Device permissions are currently listed under `resources` (historical quirk — kept for backwards compatibility), e.g. `resources: [storage, device.location, device.camera]`. A future manifest version may move them under a dedicated `device:` key; the parser will continue to accept the old form.

### Escalation via `approvalRequired`

Some operations are too sensitive to run silently even when the relevant permission is granted. For those, the app lists **action names** (free-form strings, `noun.verb` by convention) under `approvalRequired`. When the app invokes such an action, the sandbox bridge pauses the call and sends an `approval_request` WS message to the frontend, which renders an inline modal. The call only proceeds if the user clicks "Approve".

```yaml
permissions:
  resources: [email, storage]

approvalRequired:
  - email.send          # every outbound email needs a click-through
  - email.delete        # destructive
  - report.export       # sensitive data leaving the workspace
```

Action names are app-defined — the platform does not interpret them beyond displaying them in the modal and matching them against the list at call time. The approval modal also shows a `danger_level` (`low` | `medium` | `high`) that the app can include in the `approval_request` message; unknown levels default to `high`.

See the "Sandbox bridge protocol" section above for the full `approval_request` / `approval_response` message shapes.

### Per-install vs per-app permissions

Permissions are declared at the **app** level (in the manifest) and are **static for the lifetime of the installed version**. They are identical across all installs of the same app version — including multi-instance installs with different `name` parameters (see "Multi-Instance App Manager" in the project docs).

This means:
- A single app cannot request "more" permissions for one of its named instances than another — the manifest is the authoritative set.
- Upgrading an app to a new version that adds permissions triggers a re-consent prompt at the next install or update (planned for Sprint 3).
- Revoking permissions on an installed app requires uninstalling it; there is no per-install runtime toggle today.

OAuth integration scopes (e.g. "which Google scopes does `integrations.google` actually grant?") are a separate concern negotiated at `@connect` time, not at install time — the permission only says "this app may use the connected Google account", the scopes say "in the following ways".

### Rejection behaviour

What happens when an app requests or uses a permission it shouldn't:

1. **Manifest validation — unknown permission string**: `parseAndValidate()` in `manifest-parser.js` rejects the manifest with an error like `Unknown permission: "filesystem". Valid: storage, email, database, ...`. The install fails at the router with a 400 response before any files are downloaded to the bridge. Example error body:
   ```json
   { "field": "permissions.resources[2]", "message": "Unknown permission: 'filesystem'" }
   ```

2. **Runtime — permission not in manifest**: The sandbox bridge and router middleware check each capability call against the declared `permissions` before executing it. Calls to an undeclared capability **fail silently inside the sandbox** — the call resolves with `undefined` / empty result, no exception is thrown, and no user-facing error appears. This is deliberate: a malicious app should not be able to probe which permissions are in effect by catching exceptions.

3. **Runtime — network port not in manifest**: `sandbox-proxy.js` resolves the app record from DB (not from client-provided data) and checks the requested port against `permissions.network`. Mismatched ports return HTTP 403 with `Port N not allowed. Allowed: [...]`. Ports not in loopback range (non-`localhost`/`::1`/`127.x`) return 403 with `Only localhost URLs allowed via proxy`.

4. **Runtime — `system.*` on a non-system-trust app**: The router API routes that gate system permissions return HTTP 403 with `system permission requires trust=system`. The check is based on the `trust` field of the app's signed manifest record, not on a header or cookie the app controls.

5. **Runtime — `approvalRequired` action invoked without approval**: The sandbox bridge intercepts the call, emits `approval_request`, and blocks the calling coroutine until the frontend replies with `approval_response`. If the user clicks "Deny" (or the 5s…10min timeout expires), the call resolves with an `ApprovalDeniedError` thrown inside the sandbox — this is one of the few cases where an exception **is** thrown rather than silent failure, because the app has opted in to knowing.

### Summary of enforcement layers

From outermost to innermost:

| Layer | What it checks | When |
|-------|---------------|------|
| Manifest parser (`manifest-parser.js`) | Declared permission strings are in `VALID_PERMISSIONS` | At install / update time |
| Router API middleware | `system.*` permissions require `trust: system` | Per-request, on gated endpoints |
| Router `sandbox-proxy.js` | Network port matches `permissions.network` entries; hostname is loopback | Per `xai.http()` call |
| Router `DataService` | Storage/database calls are scoped to `{app_domain, chat_id}` | Per read/write |
| Router OAuth connector registry | User has connected the relevant provider before `integrations.*` is usable | Per tool / integration call |
| Sandbox bridge (iframe host) | Capability calls match declared `permissions` categories | Per `xai.*` SDK call |
| Workspace memory / tool router | `memory.*` and `tool.*` calls attributed + scoped | Per call |
| Frontend approval modal | `approvalRequired` actions pause until user consents | Per sensitive call |

No single layer is sufficient on its own — the defense-in-depth is deliberate. In particular, **never assume the sandbox bridge check alone is enough**: anything security-relevant must also be enforced server-side (at the router or workspace gateway), because a compromised sandbox iframe can forge any `xai.*` call.

---

## System mini-apps: M0 limitations

The trust-tier pipeline is intentionally minimal in M0. The following constraints will be lifted in later milestones, but today's callers should plan around them:

- **In-tree only.** System mini-apps must live inside `xaiworkspace-frontend/src/app/system-mini-apps/<slug>/` and be registered in `SYSTEM_MINI_APPS`. The router will not load a system mini-app from an external repo, and there is no publish-time signing step.
- **No permission sandboxing.** Because the component is rendered directly in the frontend bundle, it can `inject()` any Angular service the host app provides. The `system.*` permission strings are documentary — they describe intent and help reviewers, but nothing blocks an in-tree component from calling services outside its declared permissions.
- **Build-time bundled, not lazy-loaded per mini-app.** Every system mini-app adds to the frontend initial bundle (mindful of the 2MB warn / 2.5MB error budget). There is no per-mini-app code splitting in M0.
- **No hot-swap or per-install versioning.** System mini-app version strings are metadata only — upgrading a system mini-app means shipping a new frontend build. Users cannot pin, roll back, or run two versions side-by-side.
- **No per-user install state.** System mini-apps appear for every authenticated user and cannot be uninstalled. Per-user enable/disable would need to be layered on top by the host (e.g. via feature flags).
- **No router database record.** System mini-apps are not represented in the router's `mini_apps` / `app_installs` tables. APIs that enumerate "installed apps" server-side will not include them — the combined list only exists in the frontend registry.

Out-of-tree system mini-apps are planned for **M1.1**, which will add Ed25519 signature verification, a publish flow for signed system bundles, and a runtime capability proxy that enforces `system.*` permission strings instead of relying on code review. Until then, any new system-tier surface must go through the `xaiworkspace-frontend` repo and be reviewed like first-party code.

---

## Mini-app resource API

Resources a mini-app process (pm2) can call from its workspace container. All
resources are reached over HTTP(S) using either the bridge-provided env vars
(`ROUTER_URL`, `BRIDGE_URL`, `APP_API_KEY`) or the local IPC port. Prefer the
bridge-local endpoints when available — they avoid a router round-trip.

### Environment contract

Every mini-app process launched by pm2 inherits the following env vars from
the bridge:

| Var | Scope | Purpose |
|-----|-------|---------|
| `APP_API_KEY` | every app | LiteLLM virtual Bearer for authenticated router calls. Legacy name: `ANTHROPIC_API_KEY` (still accepted but deprecated — see `connect/index.js` for a rename-tolerant consumer) |
| `ROUTER_URL` | every app | Router base URL (`https://router.xaiworkspace.com` or env equivalent) |
| `BRIDGE_URL` | every app | Bridge loopback URL for agent-to-agent IPC (default `http://127.0.0.1:19099`) |
| `APP_PORT` | apps with `manifest.mcp.port` or `manifest.permissions.network` | Port the app must bind to on `127.0.0.1` |
| `APP_INSTANCE_NAME` | multi-install apps | Unique per install (`default`, or user-chosen slug-compatible name) |
| `APP_PARAMETERS` | manifest.parameters consumers | JSON-serialised user-supplied install parameters |

Never log `APP_API_KEY` — it is a per-app LiteLLM virtual key. Treat it like
a rotating secret.

### OAuth-backed secrets (`oc-secret`)

Mini-apps declaring `permissions.secrets: [...]` can request a user-scoped
OAuth token over the router's `/api/oauth/connections` API. Tokens are
server-refreshed; the mini-app never stores token material on disk.

```js
// Retrieve a connected provider's current access token (auto-refresh included)
const res = await fetch(`${process.env.ROUTER_URL}/api/oauth/connections/${provider}/token`, {
  headers: { Authorization: `Bearer ${process.env.APP_API_KEY}` },
});
const { access_token, expires_at, account_email } = await res.json();
```

Multi-account (post-April 2026): pass `?account_email=<email>` to scope the
lookup to a specific account. When omitted, the router returns the oldest
(primary) account — matches the legacy single-account contract so existing
mini-apps don't need changes to keep working.

List connections:

```js
await fetch(`${process.env.ROUTER_URL}/api/oauth/connections`, {
  headers: { Authorization: `Bearer ${process.env.APP_API_KEY}` },
}).then(r => r.json());
// → { connections: [{ provider, provider_user, scope, expires_at, ... }] }
```

Disconnect:

```js
await fetch(
  `${process.env.ROUTER_URL}/api/oauth/connections/${provider}` +
  (accountEmail ? `?account_email=${encodeURIComponent(accountEmail)}` : ''),
  { method: 'DELETE', headers: { Authorization: `Bearer ${process.env.APP_API_KEY}` } },
);
```

The canonical MCP surface for OAuth lives in `xaiworkspaceApps/apps/connect/index.js` — when `@connect` is installed and running, MCP callers prefer its JSON-RPC tools (`get_token`, `list_connections`, `is_connected`, `disconnect`) over the raw HTTP API.

### Per-user key-value storage (`/api/data`)

Apps declaring `permissions.storage: true` can persist JSON rows scoped to
the user + app + table. Backed by `oc_app_data` in Postgres.

| Method | Path | Body / Query | Returns |
|--------|------|-------------|---------|
| `GET`  | `/api/data/{appDomain}/{table}` | — | `{ items: [{ id, data }] }` |
| `GET`  | `/api/data/{appDomain}/{table}/{id}` | — | `{ id, data }` |
| `POST` | `/api/data/{appDomain}/{table}` | `{ data: {...} }` | `{ id, data }` |
| `PATCH`| `/api/data/{appDomain}/{table}/{id}` | `{ data: {...} }` | `{ id, data }` |
| `DELETE`| `/api/data/{appDomain}/{table}/{id}` | — | `{ ok: true }` |

`appDomain` must match the app's manifest `identifier` (e.g. `com.xaiworkspace.connect`). Cross-app reads are rejected. `{table}` matches `^[a-z0-9][a-z0-9_-]{0,49}$`.

```js
// Save a per-user row
await fetch(`${process.env.ROUTER_URL}/api/data/${APP_DOMAIN}/preferences`, {
  method: 'POST',
  headers: {
    Authorization: `Bearer ${process.env.APP_API_KEY}`,
    'Content-Type': 'application/json',
  },
  body: JSON.stringify({ data: { theme: 'dark', model: 'sonnet-4.6' } }),
});
```

Concurrency: last-write-wins at the row level. If you need atomic read-modify-write, use the `mcpCall` bridge (below) with a server-side transaction.

### Send chat messages (`send_message`)

Apps declaring `permissions.chat: [chat.send]` can push messages into the
user's chat window via the bridge's WebSocket bus.

```js
await fetch(`${process.env.BRIDGE_URL}/api/app-message`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    from: process.env.APP_INSTANCE_NAME || 'default',
    to: 'chat',                  // or another agent instance name
    message: '...',              // markdown supported
  }),
});
```

The bridge relays `send_message` to the frontend `app.handler.ts` which
appends to chat history. The message `sender` renders as `system`; use
`buttons` on the payload to add interactive callback buttons.

Cross-bridge / cross-domain routing is Milestone 1+ (see `MVP-Plan.md` item 7).

### Request user approval (`approval_request`)

For security-sensitive actions (payments, destructive ops, elevated scopes)
the app can pause and ask the user inline via a modal:

```js
// WS payload shipped to the frontend via the bridge
{
  type: 'approval_request',
  request_id: crypto.randomUUID(),
  app_identifier: 'com.xshopper.payments',
  title: 'Approve $500 payment to supplier-abc?',
  description: 'This will transfer funds via Stripe. Cannot be reversed.',
  danger_level: 'high',        // 'low' | 'medium' | 'high', defaults to high
  timeout_ms: 60_000,          // clamped to [5_000, 600_000]
}
```

The frontend modal returns `{ request_id, approved: boolean }` on the same
WS connection. If the user does not respond within `timeout_ms`, the
approval resolves as `approved: false`.

### MCP server registration (self-registering apps)

Apps with `manifest.mcp.port` running their own JSON-RPC server must
register with the router so LiteLLM can route MCP calls into them:

```js
await fetch(`${process.env.ROUTER_URL}/api/mcp/register`, {
  method: 'POST',
  headers: {
    Authorization: `Bearer ${process.env.APP_API_KEY}`,
    'Content-Type': 'application/json',
  },
  body: JSON.stringify({ appSlug: 'connect', port: 3470 }),
});
```

Re-register on startup (not just install). If registration fails, direct
`POST /mcp` calls still work — the registry is used for LiteLLM discovery
only. See `xaiworkspaceApps/apps/connect/index.js` for the canonical
exponential-backoff pattern.

### Triggers — payload schema

Triggers let a mini-app react to events, cron schedules, or webhooks without
being explicitly invoked. Declare them in the manifest under `triggers:` and
handle them at runtime by subscribing to `app_trigger` WS messages (or by
reading the HTTP body on a webhook trigger).

#### Manifest declaration

```yaml
triggers:
  - kind: cron
    config: { cron: "0 9 * * 1-5" }
  - kind: event
    config: { event: "email.received", filter: { label: "sales" } }
  - kind: webhook
    config: { events: ["push", "pull_request"] }
```

`kind` must be one of: `cron`, `event`, `webhook`. Unknown kinds are rejected
at install time.

#### WS `app_trigger` payload

All trigger kinds reach the frontend + any running pm2 mini-app via a
uniform WS envelope:

```json
{
  "type": "app_trigger",
  "appSlug": "email-manager",
  "triggerKind": "cron",
  "payload": { ... kind-specific fields ... }
}
```

Frontend handler: `src/app/services/ws-handlers/app.handler.ts` sets
`ctx.appTriggerFired` to `{ slug, kind, payload, timestamp }`. Mini-apps
running inside a workspace container can subscribe on the bridge WS at
`BRIDGE_URL` (same envelope).

#### Per-kind `payload` shape

**`cron`** (server-fired by `src/schedulers/app-triggers.js`):

```json
{
  "triggerKind": "cron",
  "cronExpr": "0 9 * * 1-5",
  "firedAt": "2026-04-20T09:00:00.000Z"
}
```

Delivery guarantee: the router uses an atomic `UPDATE … WHERE last_fired < now`
guard so a cron trigger fires at most once across horizontally scaled router
tasks. Skipped ticks (e.g. user offline) are NOT replayed — if the user was
disconnected when the cron fired, the app will not see it. Design cron
handlers to be idempotent and to reconcile from stored state on reconnect.

**`event`** (typically fired by another mini-app or a system source — e.g.
`email.received`, `file.uploaded`):

```json
{
  "triggerKind": "event",
  "event": "email.received",
  "source": "email-manager",
  "data": { ... event-specific payload ... }
}
```

Matching: when the manifest declares `config.filter`, the router only fires
the trigger if every filter field matches (string equals, array contains).
Unmatched events are dropped silently.

**`webhook`** (fired by `POST /api/app-webhook/:appSlug`):

```json
{
  "triggerKind": "webhook",
  "event": "push",          // from x-github-event or body.event
  "headers": { ... sanitized allow-listed headers ... },
  "body": { ... original POST body, parsed JSON ... }
}
```

Security: webhook endpoints require the caller to prove ownership of the
app. Built-in integrations with their own signature scheme (e.g. GitHub
`x-hub-signature-256`) are verified by dedicated handlers in
`src/routes/app-webhooks.js` before dispatch.

Headers are filtered server-side to a small allow-list (`content-type`,
`user-agent`, `x-github-event`, `x-github-delivery`, `x-hub-signature-256`).
Arbitrary request headers are not forwarded, to avoid leaking secrets or
host-specific tokens into the mini-app.

#### Design notes

- The `payload` object is forwarded verbatim from the router; never trust
  it without validation. For webhook triggers especially, run a schema
  check before acting.
- Triggers fire even when the user is offline if the mini-app is a pm2
  service — pm2 apps receive `app_trigger` over the bridge WS regardless of
  the user's browser state. Frontend components only see triggers when the
  chat WS is connected.
- A mini-app can declare multiple triggers of the same kind with different
  filters; each matching trigger fires independently.

### Rate limits + quotas

| Resource | Window | Cap (per user) |
|---------|-------|---------------|
| `/api/oauth/connections*` | 60s | 60 req |
| `/api/tools/connections` + `/api/tools/connect/*` | 60s | 30 req |
| `/api/data/*` | 60s | 120 req |
| `send_message` (bridge) | 10s | 100 req |

Exceeding returns HTTP 429 with `Retry-After` seconds. On bridge-local
endpoints, 429 is advisory — clients should back off rather than retry
in a tight loop.

