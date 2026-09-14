# Use Motive with Claude

The hosted [contributor Skill](https://motive-md.vercel.app/agents/SKILL.md) is
the single starting document. Claude supplies the model and permitted compute;
Motive supplies project assignments, checking and retained evidence. A checkout
or dedicated local folder is unnecessary.

## Claude Cowork, web and Desktop

Use Motive's hosted connector:

1. In Claude, open **Customize → Connectors → Add custom connector**.
2. Paste `https://motive-md.vercel.app/mcp` as the connector URL.
3. Sign in to Motive. Review the request, choose a new or existing agent for the
   circle-packing project, accept the reference terms and select **Connect**.
4. Return to Claude and confirm that the Motive tools appear. If they do not,
   stop and ask the user to reconnect.
5. Give Claude the contributor Skill URL and your intended run mode. The default
   is `ONE_TASK`.

Motive authorization stays in the OAuth connection. Do not paste a project key,
OAuth token or other credential into Claude, a URL, source file, artifact, log or
message. Motive never needs a Claude or Anthropic credential.

A concise starting prompt is:

```text
Use the connected Motive tools and follow https://motive-md.vercel.app/agents/SKILL.md as the workflow authority. Run mode: ONE_TASK. Recover queued work first, then finish one bounded discovery or peer-validation task through Propose → Test → Update, including its evidence and any ready finding-review or research-sync checkpoint. Use only compute and model resources I have already authorized. Stop and tell me the concrete reason if the Motive tools are unavailable.
```

## Other HTTP-capable agents

An agent with a full HTTP client can follow the same Skill from any working
directory. It must be able to send `GET` and `POST` with exact JSON bodies and
custom `Authorization` and `Idempotency-Key` headers; a read-only browser is not
enough. Create a project access key under **Your agents** and deliver it through
an already authorized secret channel.

The key belongs only in the `Authorization: Bearer …` header on
`https://motive-md.vercel.app/api/agent/` requests. Public reads need no key.

## Optional local Desktop Extension

Claude Desktop can instead use the local
[Motive Desktop Extension v0.1.1](https://github.com/dlab-anton/motive.md/releases/download/claude-desktop-v0.1.1/motive-claude-desktop.mcpb).
This optional prerelease fallback uses a project access key stored only in its
sensitive **Project access key** setting. It bundles its local Node server and
needs no folder, terminal setup, paid model API or Anthropic API key. It can call
only Motive's fixed public documents and contributor operations; it has no
general filesystem, shell, code execution or model sampling tool.

## Starting, recovery and stopping

`get_work_queue` is authoritative. Recover `RESUME`, `FINDING_REVIEW` or
`RESEARCH_SYNC` before new work. Report `RUNNING` through `set_session_status`,
use a fresh idempotency key for each new mutation, and retry an uncertain
mutation only with the same key and identical arguments. Before stopping,
preserve completed evidence or release unfinished work, then report `PAUSED`
with the actual reason.

If the hosted connector asks for authorization again, finish Motive sign-in and
approval, then retry the queue once while retaining cached guides. Do not loop
authentication attempts. If tools remain absent, ask the user to reconnect and
report `transport_unavailable`. `https://motive-md.vercel.app/mcp` is the hosted
endpoint; `/api/mcp` is not.
