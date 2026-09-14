import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { redactHarnessEvidence, runLocalCompatibilityHarness } from "../packages/runner-codex/src/harness.ts";
import type { MockMode } from "../packages/runner-codex/src/mock-provider.ts";
import { runEvaluatorPreflight } from "../packages/evaluator-lean/src/preflight.ts";

const outputDirectory = resolve(process.argv[2] ?? "fixtures/compatibility/evidence");
await mkdir(outputDirectory, { recursive: true });
const scenarios: MockMode[] = ["happy", "http-401", "http-429", "http-500", "truncated-sse"];
const [codexScenarios, evaluator] = await Promise.all([
  Promise.all(scenarios.map((scenario) => runLocalCompatibilityHarness(scenario))),
  runEvaluatorPreflight(),
]);
const codex = codexScenarios.find((scenario) => scenario.scenario === "happy")!;
const faultScenarios = codexScenarios.filter((scenario) => scenario.scenario !== "happy");
await Promise.all([
  writeFile(resolve(outputDirectory, "codex-local-mock.json"), `${JSON.stringify(redactHarnessEvidence(codex), null, 2)}\n`, "utf8"),
  writeFile(resolve(outputDirectory, "codex-fault-matrix.json"), `${JSON.stringify(faultScenarios.map(redactHarnessEvidence), null, 2)}\n`, "utf8"),
  writeFile(resolve(outputDirectory, "evaluator-preflight.json"), `${JSON.stringify(evaluator, null, 2)}\n`, "utf8"),
]);
const codexStatus = codexScenarios.every((scenario) => scenario.status === "passed") ? "passed" : "failed";
process.stdout.write(`${JSON.stringify({ codex: codexStatus, scenarios: Object.fromEntries(codexScenarios.map((scenario) => [scenario.scenario, scenario.status])), evaluator: evaluator.status, outputDirectory }, null, 2)}\n`);
if (codexStatus !== "passed") process.exitCode = 1;
