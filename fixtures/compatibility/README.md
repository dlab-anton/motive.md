# Deterministic compatibility fixture

The harness creates `motive-turn-1.input.txt` and `motive-turn-2.input.txt` in
an isolated temporary workspace. The local mock instructs Codex to read each
file in a separate tool call. The harness requires both trusted fixture files,
three distinct Responses requests, tool outputs for both call IDs, JSONL output,
and a zero process exit.

This fixture spends no money and contacts no provider. It cannot satisfy the
live-provider, cloud-sandbox, billing, compaction, or evaluator gates.
