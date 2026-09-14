import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createCircleProjectRunApplication } from '../server/project-runs/runtime.ts';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function parseCircleReconcileArguments(argv: readonly string[]): { budgetId: string } {
  if (argv.length !== 2 || argv[0] !== '--budget' || !UUID.test(argv[1] ?? '')) {
    throw new Error('Usage: reconcile-circle-project --budget <budget-uuid>');
  }
  return { budgetId: argv[1]! };
}

export async function reconcileCircleProject(argv: readonly string[], env = process.env): Promise<number> {
  const { budgetId } = parseCircleReconcileArguments(argv);
  const application = await createCircleProjectRunApplication(env);
  try {
    const result = await application.reconcileBudget(budgetId);
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return result.dispatch === null || result.dispatch.status === 'UNCONFIGURED' ? 2 : 0;
  } finally {
    await application.close();
  }
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  reconcileCircleProject(process.argv.slice(2)).then(code => { process.exitCode = code; }).catch(error => {
    process.stderr.write(`${error instanceof Error ? error.message : 'Circle reconciliation failed.'}\n`);
    process.exitCode = 1;
  });
}
