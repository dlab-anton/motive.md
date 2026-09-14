import { assertRecordedOperationId } from './policy.ts';
import { MAX_OWNED_SANDBOX_DISCOVERY, type OwnedSandboxObservation, type ProviderSandboxStatus, type SandboxSdkFactory, type SandboxState } from './types.ts';
import type { ProviderObservation } from '../../orchestration/src/store-types.ts';

function terminal(status: ProviderSandboxStatus): boolean { return ['stopped', 'failed', 'aborted'].includes(status); }
function state(status: ProviderSandboxStatus): SandboxState {
  return status === 'pending' ? 'PROVISIONING' : status === 'running' ? 'RUNNING' : status === 'stopped' ? 'STOPPED' : terminal(status) ? 'FAILED' : 'STOPPING';
}
function owned(name: string, tags?: Record<string, string>): boolean {
  return /^motive-[we]-[0-9a-f]{32}$/.test(name) && tags?.['motive-owner'] === 'control' &&
    tags['motive-kind'] === (name.startsWith('motive-w-') ? 'worker' : 'evaluator');
}

/** Account-scoped orphan inspection. No resume, command, or create API is exposed. */
export class VercelOrphanProvider {
  constructor(private readonly sdk: SandboxSdkFactory, private readonly effects: 'suspended' | 'durable-controller' = 'suspended') {}

  async discover(): Promise<{ sandboxes: OwnedSandboxObservation[]; complete: boolean }> {
    const result = await this.sdk.listOwned({ namePrefix: 'motive-', tags: { 'motive-owner': 'control' }, maximumResults: MAX_OWNED_SANDBOX_DISCOVERY });
    return {
      complete: result.complete,
      sandboxes: result.sandboxes.filter(item => owned(item.name, item.tags)).map(item => ({
        sandboxId: item.name, sessionId: item.sessionId, state: state(item.status), providerStatus: item.status,
        persistent: item.persistent, expiresAt: item.expiresAt ?? null, tags: { ...item.tags }, observedAt: new Date(),
      })),
    };
  }

  async stopOwned(item: OwnedSandboxObservation, operationId: string): Promise<ProviderObservation> {
    if (this.effects !== 'durable-controller') throw new Error('SANDBOX_EFFECTS_SUSPENDED');
    assertRecordedOperationId(operationId);
    if (!owned(item.sandboxId, item.tags) || !item.sessionId) throw new Error('ORPHAN_IDENTITY_INVALID');
    const current = await this.sdk.get({ name: item.sandboxId, resume: false });
    if (current.name !== item.sandboxId || current.sessionId !== item.sessionId || !owned(current.name, current.tags) ||
        [...new Set([...Object.keys(item.tags), ...Object.keys(current.tags ?? {})])]
          .some(key => key.startsWith('motive-') && current.tags?.[key] !== item.tags[key])) {
      throw new Error('ORPHAN_IDENTITY_CHANGED');
    }
    // Persistent owned orphans also need teardown. Unlike a worker launch, this
    // path does not bless their snapshot or start any code inside them.
    const status = terminal(current.status) ? current.status : (await current.stop()).status;
    return { providerStatus: status, providerTerminal: terminal(status), state: terminal(status) ? 'TERMINATED' : 'STOP_REQUESTED', observedAt: new Date().toISOString() };
  }
}
