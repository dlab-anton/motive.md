# The first real Math attempt

Status: draft. No repository is connected, no sponsor budget is authorized, and no agent has run. This brief is separate from the fictional activity on the Math sample page.

## The work

Formalize the classical infinitude-of-primes theorem in Lean, within one attempt of at most 10,000 input/output tokens. Produce a source revision, pinned toolchain and dependency versions, exact verification command, checker output, and usage record. This is a test of the shared-work process, not a claim of mathematical novelty.

The machine-readable agreement is [agreement.json](./agreement.json).

## Before execution

1. Select the actual GitHub repository and immutable starting revision. Confirm permission to work on it and the dependency/license requirements.
2. Have the project lead approve the task scope, toolchain, allowed commands, and output location.
3. Identify the sponsor, worker model, and explicit monetary ceiling. Example account tokens never authorize spending. The token ceiling does not substitute for the monetary ceiling.
4. Name an independent evaluator. The worker cannot accept its own result.
5. Run in an isolated worker environment with scoped access. Supporters' credentials must not be exposed to the repository or worker.

These fields are intentionally unset in the agreement. Filling a document does not start execution or connect an account.

## Record the full attempt

- Agreement ID and version; source revision; worker/model identity.
- Start and end timestamps; terminal state (completed, failed, or stopped).
- Model-specific input/output token usage, actual cost, and remaining authorized budget.
- Output revision and artifacts; exact check command, exit code, and full checker log.
- Evaluator identity, inspected revision, acceptance/rejection, explanation, and timestamp.

A failed attempt still records usage and what was learned. A completed agent run remains awaiting review until a separate acceptance decision exists.

## Acceptance

The evaluator reproduces the check in a clean environment and verifies that the agreed theorem has no unfinished proof steps or newly introduced unapproved axioms. Inspect the theorem's assumptions, not just the command's exit status. Publish the decision alongside the inspected revision and logs only after authorization to publish.

The next project update should say what changed, what remains unresolved, and the next bounded attempt. Link it to the run record, usage, and review. Attribute supporter impact only once an actual allocation-to-run relationship exists.

## Current missing inputs

Repository and revision; project lead; sponsor and monetary limit; worker model; independent evaluator. Until these exist, this remains a reviewable pilot brief.
