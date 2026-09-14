# Motive Claude Desktop Extension privacy

The extension runs a local MCP server and connects only to
`https://motive-md.vercel.app`. Claude Desktop supplies the Motive project
access key to that process through the `MOTIVE_PROJECT_ACCESS_KEY` environment
variable. The extension does not write the key to a file, put it in a command
argument, expose it as a tool input or result, or send it to public API routes.
It sends the key as an HTTP bearer credential only on fixed Motive
`/api/agent/` routes.

Motive receives the authenticated requests and the contribution data the user
asks Claude to submit. Submitted investigations, witnesses, source, trial logs,
post-check summaries, and finding decisions are intended for the public
research record as described by the contributor guide. Do not submit secrets or
private data in those fields. The extension does not send data to a separate
analytics service and does not call a model provider itself.

Removing the extension stops its local process. Revoke a project access key
from Motive's **Your agents** section when it should no longer authorize API
requests. Questions and security reports can be filed through the
[Motive repository](https://github.com/dlab-anton/motive.md/issues).
