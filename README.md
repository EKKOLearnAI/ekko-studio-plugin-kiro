# Kiro CLI for Ekko Studio

Kiro CLI registers as `plugin:kiro/kiro` and provides streaming single chat with native Kiro models.

## Setup

1. Install and enable this plugin in Studio’s Plugin Center.
2. In **Agent management → Kiro CLI**, use **Install** on macOS or Linux. The Studio host needs `unzip`. On Windows, follow the Kiro installation guide and refresh detection. External binaries on the Studio host remain managed by their original installer.
3. Open **Kiro CLI → Configuration file** and run the displayed login command as the Studio service OS account. Then refresh the model list in chat and select a Kiro model.

Use **Check for updates**, **Update** and **Delete** for a Studio-managed engine. Deleting it preserves the native sign-in, settings and conversations. Set `EKKO_KIRO_EXECUTABLE` to an absolute binary path to select an external installation.

## Settings

- **Skills** edits user-level Kiro Skill descriptions and Markdown. Enable, disable and delete operate on `SKILL.md` and preserve any companion files.
- **MCP servers** edits Kiro’s native user-level MCP entries. Existing credentials are masked. Keeping a mask preserves the existing value.
- **Configuration file** shows the runtime version and login command and edits Kiro’s native `settings/cli.json`. Saves check the last-read revision.

The settings pages use the Studio host’s `KIRO_HOME` or `~/.kiro`, shared with the native Kiro CLI. Only the Studio account and Profile that enabled the plugin can use its native login or edit these settings.

## Runtime

The plugin starts Kiro CLI 3.x in ACP V3 mode. It uses the native catalog and forwards Kiro tool permission requests through Studio’s approval dialog. Attachments are sent as ACP images when supported or staged in a private directory for the native file tools. Studio’s authorized MCP servers are sent with each session.

Kiro’s documented ACP interface uses its own account and model catalog. This plugin exposes global mode. Each turn starts a native session with Studio conversation history. See the [runtime contract](docs/CONTRACTS.md) and [Kiro ACP guide](https://kiro.dev/docs/cli/v3/acp-migration/).

## Develop

Use Node.js 24.2 or a newer 24.x release.

```sh
npm ci --ignore-scripts --no-audit --no-fund
npm run harness:check
npm test
npm pack --dry-run --ignore-scripts
```

The plugin is MIT licensed. The bundled Studio SDK retains its [license](sdk/LICENSE) and [notice](sdk/NOTICE). The vendored YAML parser retains its [license](assets/YAML-LICENSE).

The [Kiro app icon](https://github.com/kirodotdev/Kiro/blob/a57ed51da0ca73cf6e78cf92e870b6806d200cea/assets/kiro-icon.png) identifies the supported Kiro CLI. Kiro branding belongs to Amazon Web Services.
