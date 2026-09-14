# Local evaluator fixture inputs

These are synthetic infrastructure fixtures, not an approved project challenge.
The pinned stock toolchain ran the baseline revision of these cases in the isolated systemd QEMU
guest. The valid case exited 0, five negative cases exited 1, and the two
forbidden inputs were rejected before execution. See
[toolchain evidence](../../../packages/evaluator-lean/native/toolchain-build-evidence.json).
These are behavioral observations; the open descendant-cleanup condition and
human acceptance remain separate requirements.

The namespace-review R2 revision removes an unused `import Lean` from the
forged-output fixture while retaining the fake acceptance log and incomplete
target. The earlier namespaced run did not reach the required axiom rejection
for that fixture and is retained as failed evidence. The stock image's baseline
fixture remains unchanged. R2 now passes its specific forged-log and axiom
assertions in the separate [namespace review](../../../docs/EVALUATOR-NAMESPACE-EVIDENCE.md).

The trusted `Challenge.lean`, `lakefile.toml` and `comparator.json` must be staged
from this reviewed fixture directory. Only each case's permitted candidate
`.lean` files enter the solution workspace. Every run starts from a fresh clean
project, with pinned tools and no candidate-supplied `.olean` or build cache.

| Case | Required observation |
| --- | --- |
| valid-proof | Comparator verifies the exact target with an empty axiom policy. Human acceptance stays pending. |
| wrong-target-statement | A valid proof of a different type is rejected. |
| incomplete-proof | A target using `sorryAx` is rejected. |
| unapproved-custom-axiom | A target using the candidate's axiom is rejected. |
| transitive-incomplete-dependency | `sorryAx` in an imported candidate theorem is rejected transitively. |
| forged-acceptance-output | Candidate log text cannot promote an incomplete proof or record human acceptance. |
| altered-challenge | Candidate ingestion rejects `Challenge.lean` before compilation. |
| modified-build-or-checker | Candidate ingestion rejects the replacement Lake configuration before execution. |

The last two cases test the trusted staging boundary. They must never be tested
by executing a candidate's replacement build or challenge configuration.
