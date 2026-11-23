# Kiro plugin contract

Both the plugin and Agent IDs are `kiro`. The plugin implements Studio Agent API v1 for global single chat with streaming. Use [the SDK types](../sdk/src/agents.ts) and [the RPC contract](../contracts/plugin.json) for the boundary fields.

## Engine management

On macOS and Linux, Studio installs the upstream stable ZIP for the host architecture and Linux libc. It verifies the published size and SHA-256, extracts only the standalone binary and verifies its version before selecting it. The official vendor MSI and other external installations use the platform’s installer. `EKKO_KIRO_EXECUTABLE` takes precedence over detection.

Plugin data under `engine/` contains managed binaries. `current.json` selects a verified engine directory. An absent pointer allows external detection, and a null pointer indicates a removed managed installation. Upgrade checks the previously observed version and selects the verified replacement atomically. Removing an engine leaves Kiro’s native authentication and settings intact.

## Settings RPC

The Skill, MCP and configuration views use the same layout and actions as Cline. They read the native user-level `skills/`, `settings/mcp.json` and `settings/cli.json` under `KIRO_HOME` or `~/.kiro`. Writes compare the revision from the most recent read. Skill edits preserve companion files and other YAML frontmatter fields. The MCP editor preserves other entries and unrelated top-level fields. The JSON editors mask credentials and retain the corresponding existing value when the mask is kept. `native-login` produces the quoted login command or an empty command when the engine is missing.

The enabling Studio user and Profile own these RPCs, native credentials and engine changes. Runtime turns also check session ID, Agent ID and mode before using native state.

## ACP V3

- Launch uses `kiro-cli acp --agent-engine=v3`. The catalog reads the native session’s model options. Selected model and effort are confirmed against current ACP configuration. The catalog maps the standard authentication error to the Studio sign-in state.
- Each turn starts a fresh native session and passes the workspace, Studio history and authorized MCP entries. The configured Kiro model receives the turn. Project tools and trusted settings are evaluated by Kiro.
- Approval requests are limited to the current ACP session. Studio presents the request and returns an offered one-time allow or deny option. A timeout, interruption or missing answer cancels the request.
- The plugin streams text, reasoning summaries and tool lifecycles, then returns the complete response once. It sends `session/cancel` on interruption and closes the process after the turn or startup timeout. Studio can estimate token usage when native counts are unavailable.
- Up to 32 attachments and 32 MiB per turn are resolved through authorized Studio APIs. Supported images are sent directly within a 6 MiB inline budget. Other inputs are staged in a private per-turn directory exposed to the native file tools. Staged files are removed at turn end.
- The plugin does not claim scoped models or native session resume. Studio supplies its own transcript on subsequent turns. Kiro stderr and raw ACP errors are discarded.

Settings follow Kiro’s existing native format, so there is no plugin settings migration on first install.
