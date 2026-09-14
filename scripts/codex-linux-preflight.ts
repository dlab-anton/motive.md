import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { runLinuxCompatibilityHarness } from "../packages/runner-codex/src/linux-harness.ts";

const outputPath = resolve(process.argv[2] ?? "fixtures/compatibility/evidence/codex-profile-linux-0.153.4.json");
const evidence = await runLinuxCompatibilityHarness();
await mkdir(resolve(outputPath, ".."), { recursive: true });
await writeFile(outputPath, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
process.stdout.write(`${JSON.stringify({ status: evidence.status, outputPath, cleanup: evidence.cleanup }, null, 2)}\n`);
if (evidence.status !== "passed") process.exitCode = 1;
