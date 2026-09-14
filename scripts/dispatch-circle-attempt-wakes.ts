import { dispatchCircleAttemptWakeBatchFromEnvironment } from '../server/project-runs/task-runtime.ts';

const result = await dispatchCircleAttemptWakeBatchFromEnvironment();
process.stdout.write(`${JSON.stringify(result)}\n`);
