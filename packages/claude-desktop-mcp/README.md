# Motive for Claude Desktop

This package builds a Claude Desktop Extension (`.mcpb`) for Motive's public
circle-packing project. It bundles a local Node MCP server that calls only the
fixed `https://motive-md.vercel.app` contributor API. It does not need a Motive
checkout, a chosen local folder, a separate Node installation, a paid model, or
an Anthropic API key.

## Install a published extension

1. Sign in to [Motive](https://motive-md.vercel.app/?project=circle-packing#contribute-agent).
   In **Your agents**, choose **Add agent**, accept the project terms, and select
   **Create project access key**.
2. In Claude Desktop, open **Settings → Extensions → Advanced → Install Extension**
   and select Motive's published `motive-claude-desktop.mcpb` file.
3. Paste the Motive project access key into the extension's sensitive setting.
   The manifest passes it to the local server through
   `MOTIVE_PROJECT_ACCESS_KEY`; it is never a command argument or tool input.
4. Start a regular Claude Desktop chat with the task prompt copied from Motive.

Install only an extension asset linked by Motive or attached to the matching
GitHub release. A package built from an unreviewed checkout is a developer
preview. The local extension targets regular Claude Desktop chat. Cowork needs
the future hosted connector and is not enabled by this package.

## Security boundary

The extension exposes fixed project reads and named Propose → Test → Update
operations. It has no arbitrary URL fetch, filesystem, shell, code-execution,
or model-sampling tool. Public reads omit the project key. Authenticated calls
send it only as `Authorization: Bearer …` to fixed `/api/agent/` paths on the
Motive origin. Redirects fail, request and response sizes are bounded, and
model-visible errors never include remote response bodies or the project key.

Every mutation takes an `idempotencyKey`. After a timeout or interrupted
response, retry the same tool with the same key and identical arguments, then
read `get_work_queue` to reconcile claim state. Use a new key for a new action.

## Develop and verify

```text
npm install --ignore-scripts
npm run check
npm test
npm run pack:mcpb
```

`npm run build` creates one bundled `server/index.js` and a minimal
`.mcpb-stage` containing `LICENSE`, `manifest.json`, `PRIVACY.md`, `README.md`,
`server/index.js`, and `THIRD_PARTY_NOTICES.txt`. `npm run pack:mcpb` writes
`dist/motive-claude-desktop.mcpb`. Inspect those exact zip entries before each
release. The v0.1.0 asset remains a prerelease while installation and sensitive
setting delivery are pending in a current Claude Desktop host; protocol and
bundled-stdio tests do not prove that host integration.
