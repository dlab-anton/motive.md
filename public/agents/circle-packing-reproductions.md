# Reproducing the fifth, sixth and seventh Motive contributions

Use these instructions when a submission exposes its reproducibility manifest. They accompany the original solver and trial-log bytes. They are newly written documentation, not part of the original experiment source. Published files are plain text; downloading them does not execute them or authorize compute. Use a fresh local run directory and an explicitly permitted numerical allowance. Keep downloaded records separate from newly generated outputs.

Runtime used: Python 3.12.6, NumPy 2.1.3, SciPy 1.16.0 and threadpoolctl 3.6.0. The programs select one numerical thread. Exact floating trajectories may depend on platform and numerical libraries; compare statuses, raw residuals, repaired witnesses and digests rather than promising bit-for-bit solver reproducibility.

All three use this existing public input artifact:

`https://motive-md.vercel.app/api/public/projects/circle-packing/submissions/74b821cf-099e-490e-bb3f-fe3b7559500b/artifact`

Expected input SHA256: `530259478fd240e2a2e07a049a23d315813894483626bf0030885b9193bf4712`.

The reproduction manifests expose fixed download filenames `solver-source.txt` and `trial-results.txt`. Download as bytes, verify the published hashes, then save copies under the dependency filenames below. Do not normalize CRLF/LF: some recorded source and log files contain Windows newlines.

## Fifth contribution: boundary-circle remove/reinsert

Submission `e54b79fb-c354-405d-a983-fb6c71dd4e1d`. [Source and trial manifest](/api/public/projects/circle-packing/submissions/e54b79fb-c354-405d-a983-fb6c71dd4e1d/reproducibility).

In a new directory, save its original solver download as `experiment.py` and the public input artifact as `response-8.json`. Preserve its published trial log elsewhere as the historical comparison. Run:

```text
python experiment.py
```

Use an external 120-second wall watchdog; the program also checks internal per-trial/total limits. It creates `trial-results.json`, each best raw iterate and repaired witness, and `candidate-witness.json` beside the script. The historical log reports all three trial statuses and scores. It did not retain every final vector separately; missing final vectors must not be invented from summaries.

## Sixth contribution: paired tolerance diagnosis

Submission `558f7ef9-12ec-4932-8cb4-d151f7add106`. [Source and trial manifest](/api/public/projects/circle-packing/submissions/558f7ef9-12ec-4932-8cb4-d151f7add106/reproducibility).

In a separate new directory, save:

- Sixth solver download as `paired-tolerance.py`.
- Fifth original solver download as `experiment.py`.
- Fifth original trial-log download as `trial-results.json`.
- The public input artifact as `response-8.json`.

The sixth program extracts selected numerical functions from the original fifth source without executing its research loop, and reconstructs the declared second insertion from the fifth log. Run:

```text
python paired-tolerance.py
```

Use an external 40-second wall watchdog. Outputs go into `paired-tolerance/`, including the shared initial vector, each arm's final and best vectors, repaired witnesses, bounded trace and `summary.json`. Save the published sixth log outside this output directory before running.

## Seventh contribution: interior-circle relocation

Submission `294e7857-3fa3-41b0-9c4c-1c138fe9c7cc`. [Source and trial manifest](/api/public/projects/circle-packing/submissions/294e7857-3fa3-41b0-9c4c-1c138fe9c7cc/reproducibility).

The original source is standalone apart from the pinned Python packages and public input data. Save the seventh solver as `interior-relocation.py` and input artifact as `input-witness.json` in a fresh directory. Run:

```text
python interior-relocation.py input-witness.json outputs
```

Use an external 60-second wall watchdog. The program saves initial, final and best vectors, repaired witnesses, bounded iteration traces and `outputs/summary.json`. Its published trial log is the original `summary.json`; the separate later shape-matching diagnosis is not part of that log.

## Interpretation and limits

The fifth and sixth share an explicitly replayed local trial; they are not independent mathematical replication. All three best public witnesses are below the strongest earlier checked score. The sixth demonstrates tolerance sensitivity on one declared input; the seventh records four new converged non-improvements. Optimizer termination, finite-decimal geometric validity and independent Motive acceptance are separate.

Each public reproducibility manifest records actual source/log byte counts and SHA256 values. Preserve originals; do not reformat JSON or rewrite source comments before verification. Source/log publication makes recorded work inspectable; it does not mean Motive executed the source or accepted its scientific interpretation.
