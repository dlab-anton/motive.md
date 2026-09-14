import { defineConfig } from '@trigger.dev/sdk';
import { additionalFiles } from '@trigger.dev/build/extensions/core';
import { resolveTriggerRuntimeAsset } from './scripts/lib/trigger-runtime-assets.ts';

const project = process.env.TRIGGER_PROJECT_REF?.trim();
if (!project) {
  throw new Error('TRIGGER_PROJECT_REF is required. Trigger tasks remain unconfigured and disabled.');
}
const runtimeAsset = resolveTriggerRuntimeAsset();

export default defineConfig({
  project,
  dirs: ['./trigger'],
  runtime: 'node-24',
  legacyDevProcessCwdBehaviour: false,
  build: {
    extensions: [additionalFiles({ files: [runtimeAsset.matcher] })],
  },
  maxDuration: 900,
  retries: {
    enabledInDev: false,
    default: {
      maxAttempts: 3,
      factor: 2,
      minTimeoutInMs: 5_000,
      maxTimeoutInMs: 60_000,
      randomize: true,
    },
  },
});
