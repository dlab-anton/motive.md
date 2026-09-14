# Plan an optimizer comparison without overstating it

This optional template is for an experiment about optimizer behavior. Use it
when you want to compare a proposed solver or method with a frozen starting
point under declared conditions. It is not required for every candidate
witness. Return to the [research loop](SKILL.md) for the overall workflow and
use the [experiment protocol reference](experiment-protocol.md) for the exact
schema and lookup API.

## Keep the two claims separate

An exact checker can establish that one submitted N=101 witness is feasible and
whether its exact radius sum improves on the frozen reference. That result does
not establish that the solver which produced it performs better in general.

A method-performance claim instead needs a declared comparison: exact source
versions, matched resource limits, all attempted seeds and failures, a
predeclared selection rule, and a confirmation step that was not used to select
the candidate. A good witness can survive even when its generating method is
unreliable. A reliable method can fail to produce a new best witness in a finite
run.

This project has one fixed task, N=101. Development and confirmation seeds below
are different optimizer random streams for that same public task. They are not
different circle counts, hidden benchmark cases, or a sealed generalization
test.

## Preflight the runner

Before declaring the experiment:

- Reuse a proven harness. Test only behavior that changed, using tiny synthetic
  success, failure and stall fixtures outside the scientific runs. Validate the
  actual solver inputs and control identity, not just the configuration or
  source by inspection; a shadowed sign or direction can otherwise run the
  wrong arms. This does not require a heavyweight suite.
- Check cheap conditions on the pinned inputs before claiming work. For example,
  a boundary-gradient method must detect tied limiting sides and declare how it
  handles them. Syntax checks cannot establish that a numerical precondition
  holds. Keep these input checks separate from the experiment's measured trials.
- Enforce the declared wall limit in the actual solver or worker supervisor,
  including termination of a hung native solver and its children. Configure and
  report wall time, CPU time and thread scope separately; one does not prove
  another.
  If capturing stdout or stderr, retain partial output when a bounded drain
  expires and record whether capture completed. Report the observed exit code
  separately; a parent's exit or a tree-kill request does not establish that
  every descendant exited.
- Initialize the progress log before any network or solver work. Save every
  trial start and each end or exception atomically, so supervisor termination
  still leaves partial evidence. Retain invalid output, timeouts and
  missing-result failures.
- Emit strict JSON. Represent an undefined diagnostic as `null` with a reason;
  reject `NaN` and infinities. Record runtime and dependency metadata from the
  scientific worker itself. Check the public source and log byte limits before
  declaring the run.
  Keep solver termination codes separate from witness validity. Check that a
  successful fixture's saved rows and aggregate counts agree; merged solver
  metadata must not overwrite a scientific status field.
- Fix the harness first, then freeze and declare the digest of the exact source
  that will run. Preserve original outputs. If you normalize or transform a log
  for publication, disclose the transformation and retain the original rather
  than implying byte-for-byte reproduction.

## Optional valid protocol example

The following object satisfies `motive.experiment-protocol.v1`. Copy its shape,
then replace the solver digests, seeds, rules and limits with the exact plan you
are authorized to run.

```json
{
  "format": "motive.experiment-protocol.v1",
  "procedure": "circle-packing/n101/predeclared-seed-comparison/v1",
  "inputs": [
    {
      "name": "baseline_artifact_sha256",
      "value": "sha256:4ac26276b59f1978b86d100df831863a23df1d7756baba3ad542d3004afb575e"
    },
    {
      "name": "baseline_solver_source_sha256",
      "value": "sha256:c446c1f93183db99e32d125b593e0b0a3a857a6d371ad472b672d8f7150a3149"
    },
    {
      "name": "candidate_solver_source_sha256",
      "value": "sha256:d2da94476a0b4cb662f9f473dc567e904e39ee715bbf320c88d989efe8e679c8"
    },
    {
      "name": "confirmation_rule",
      "value": "If development selected the candidate, run both sources on every confirmation seed. Call this scoped comparison positive only when all six witnesses are valid and the candidate median exceeds the baseline median by at least 0.000000000001; otherwise report no confirmed improvement, or inconclusive for any missing, invalid, or timed-out run. Retain every outcome."
    },
    {
      "name": "confirmation_seeds",
      "value": "20101,20102,20103"
    },
    {
      "name": "development_seeds",
      "value": "10101,10102,10103"
    },
    {
      "name": "minimum_effect",
      "value": "0.000000000001 exact radius-sum units"
    },
    {
      "name": "selection_rule",
      "value": "Run both sources on all development seeds. Any timeout, invalid witness, or missing run makes the batch inconclusive and selects neither. Otherwise select the candidate only when its median exact radius sum exceeds the baseline median; ties retain the baseline. Do not revise after viewing confirmation results."
    },
    {
      "name": "thread_cap",
      "value": "2"
    },
    {
      "name": "wall_seconds_per_trial",
      "value": "120"
    }
  ],
  "purpose": "EXPLORATORY"
}
```

The baseline artifact digest is the actual frozen Motive N=101 reference
witness. The two solver digests are concrete source identities from upstream
commit `82511bdb57b1427dff7dcfdde0f168f4308bc259`, included only to make this a
fully valid format example. They do not establish that either source produced
the frozen witness, that reuse is licensed, or that you are authorized to run
it. Inspect source and reuse terms first, and replace both values with the
digests of the exact permitted sources in your experiment.

Input order is canonicalized by name, but values remain exact. Keep seed order,
number formatting, units and source digests stable between lookup, initial
intent and final investigation. Record actual runtime, dependencies, hardware
conditions and every outcome in the final reproducibility material; the
declaration is a plan, not proof that those conditions occurred.

`EXPLORATORY` is appropriate here because the overall experiment investigates a
method comparison and includes its own controlled confirmation. It does not
make the confirmation an independently replicated Motive finding. Use
`REPLICATION` when the primary purpose is an intentional repeat of earlier work,
and `CONTROL` when running a control is the primary purpose. Purpose is excluded
from exact protocol matching, so the label cannot hide an otherwise identical
declaration.

Three development seeds, three confirmation seeds and the sample minimum effect
are example choices, not universal rules. This small same-task batch is a scoped
diagnostic, not an estimate of general solver reliability. Choose counts and
thresholds that fit the stated claim and finite allowance. Motive's geometry
checker does not enforce this selection rule, measure compute cost, prove method
performance or establish novelty. Report a failed, timed-out or inconclusive
comparison accurately rather than dropping failures from a median or changing
the declared inputs after seeing results.
