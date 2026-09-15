# Third-party notices

Motive's own source and third-party materials have separate provenance. Installing
package dependencies retains their respective license terms in those packages.

## Circle-packing reference

The N=101 reference data is attributed to **Wes Sander, MoltFire**, from
[ucsandman/discovery-loop](https://github.com/ucsandman/discovery-loop).
[The retained provenance record](public/projects/circle-packing/reference-provenance.json)
records the original frozen revision, exact source and converted witness hashes.

That historical record notes that a license was not documented when the reference
was frozen. On 14 September 2026, the upstream repository at commit
`82511bdb57b1427dff7dcfdde0f168f4308bc259` included an MIT license, copyright
2026 Wes Sander, and the source data was byte-identical to the frozen reference
(SHA-256 `257fcd9b51a9916a1bbb0bf1f1b06050663a8597513ee0330365b1892e8300f4`).
The [upstream MIT notice](LICENSES/discovery-loop-MIT.txt) is included here.
The frozen evidence has not been rewritten to imply that this license review
happened earlier.

## Matrix multiplication reference and fixtures

The `matmul-4x4x4` reference scheme is constructed from Volker Strassen's 1969
algorithm applied recursively; no third-party bytes are copied into it.
[The provenance record](public/projects/matmul-4x4x4/reference-provenance.json)
records the construction, the frozen witness hash and the cross-check.

The cross-check and the checker test fixtures under `fixtures/matmul/upstream/`
are byte-identical copies of scheme files from
[dronperminov/FastMatrixMultiplication](https://github.com/dronperminov/FastMatrixMultiplication)
at commit `db560ca5811bc38d5a6d5c0a3ec4315937ceabce`, MIT license, copyright 2025
Andrew Perminov. The [upstream MIT notice](LICENSES/FastMatrixMultiplication-MIT.txt)
is included here and the per-file hashes are listed in
[fixtures/matmul/README.md](fixtures/matmul/README.md). Two of those files
re-encode factorizations published by DeepMind's AlphaTensor project (Apache 2.0
code, CC-BY 4.0 materials). Sedoglavic's catalogue at fmm.univ-lille.fr is cited
as context only; none of its files are redistributed.

## Interface assets and dependencies

Geist is supplied through `@fontsource-variable/geist` under its included font
license. Lucide, React, and the other installed dependencies retain their own
license notices. The GitHub mark identifies GitHub; no affiliation or endorsement
is implied. Referenced papers and external project websites retain their
respective rights and attribution.
