# Matrix multiplication scheme fixtures

`upstream/` holds byte-identical copies of scheme files from
[dronperminov/FastMatrixMultiplication](https://github.com/dronperminov/FastMatrixMultiplication)
at commit `db560ca5811bc38d5a6d5c0a3ec4315937ceabce` (master on 5 September 2026),
MIT license (copyright 2025 Andrew Perminov; see
[LICENSES/FastMatrixMultiplication-MIT.txt](../../LICENSES/FastMatrixMultiplication-MIT.txt)).
File names prefix the upstream directory. Each was verified exactly over the
integers by `src/lib/matmul.test.ts`; the `u`/`v`/`w` index convention Motive
uses was derived from these files and confirmed by those checks.

| Fixture | Upstream path | SHA-256 |
| --- | --- | --- |
| `alpha_tensor-2x2x2_m7_ZT.json` | `schemes/known/alpha_tensor/2x2x2_m7_ZT.json` | `528a5f73e7cb3cbf5fa0f0c1bbbc5695873bd67ee3099118fcb8f67a28bf2fd9` |
| `a_60_addition-3x3x3_m23_additions60_ZT.json` | `schemes/known/a_60_addition/3x3x3_m23_additions60_ZT.json` | `f9b4ee3167e60bae1d8276a31e9c43d46a1e2d69ba5362e10a20406ee3a9f65a` |
| `results_ZT-4x4x4_m49_ZT.json` | `schemes/results/ZT/4x4x4_m49_ZT.json` | `8b3d86d816f70f34b4dc47437ff1a724ebec67302dc91edc8805aae0d9789f33` |
| `results_ZT-3x3x6_m42_ZT.json` | `schemes/results/ZT/3x3x6_m42_ZT.json` | `5dcbeabbdc1c994f9ba956207aa03393bbabe4450991f4b7a82935006cfed4d5` |
| `results_ZT-2x4x5_m33_ZT.json` | `schemes/results/ZT/2x4x5_m33_ZT.json` | `ff536f28e6331b2b4a7ca333b1a998c6f1b54d1220d51da0fe10236aa0fed95a` |
| `alpha_tensor-2x4x5_m33_Z.json` | `schemes/known/alpha_tensor/2x4x5_m33_Z.json` | `5dc40edff46214faf4814d3d73da1e920a0ae32749d358458c90b47c557696b0` |
| `results_ZT-3x6x6_m82_ZT.json` | `schemes/results/ZT/3x6x6_m82_ZT.json` | `299d9ad5718203469d2b6eca3ee8cb65ba0119e8039d621e514d5fc99380421b` |

The `alpha_tensor` files re-encode factorizations published by DeepMind
(Fawzi et al., 2022, Apache 2.0 / CC-BY 4.0); the `results_ZT` files are
ternary schemes found by Perminov at previously known ranks. The frozen
`matmul-4x4x4` reference is not one of these files: it is Strassen's 1969
scheme applied recursively, built by `scripts/freeze-matmul-reference.ts`
and cross-checked against `results_ZT-4x4x4_m49_ZT.json`.
