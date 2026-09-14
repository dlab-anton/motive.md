import { redactHarnessEvidence, runLocalCompatibilityHarness } from "./harness.ts";

const evidence = redactHarnessEvidence(await runLocalCompatibilityHarness("happy"));
process.stdout.write(`${JSON.stringify(evidence)}\n`);
if (evidence.status !== "passed") process.exitCode = 1;
