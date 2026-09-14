import { describe, expect, it } from 'vitest';
import { parseCleanupArguments, selectUnusedMotiveImageRefs } from './cleanup-motive-docker.ts';

describe('Motive Docker cleanup selection', () => {
  const rows = [
    { Repository: 'motive-evaluator', Tag: 'old', ID: 'sha256:unused-shared', Size: '18GB' },
    { Repository: 'unrelated/research', Tag: 'keep', ID: 'sha256:unused-shared', Size: '18GB' },
    { Repository: 'motive-control', Tag: 'review', ID: 'sha256:stopped-container', Size: '2GB' },
    { Repository: 'motive-worker', Tag: 'live', ID: 'sha256:running-container', Size: '4GB' },
    { Repository: 'other', Tag: 'latest', ID: 'sha256:other', Size: '1GB' },
  ];

  it('removes only motive refs while preserving a shared unrelated tag', () => {
    const selected = selectUnusedMotiveImageRefs(rows, new Set());
    expect(selected.removableRefs).toContain('motive-evaluator:old');
    expect(selected.removableRefs).not.toContain('unrelated/research:keep');
    expect(selected.uniqueImages.find(image => image.id === 'sha256:unused-shared')?.otherRefs)
      .toEqual(['unrelated/research:keep']);
  });

  it('protects every motive ref whose image ID belongs to a running or stopped container', () => {
    const selected = selectUnusedMotiveImageRefs(rows, new Set(['sha256:stopped-container', 'sha256:running-container']));
    expect(selected.protectedRefs).toEqual(['motive-control:review', 'motive-worker:live']);
    expect(selected.removableRefs).not.toContain('motive-control:review');
    expect(selected.removableRefs).not.toContain('motive-worker:live');
  });

  it('requires an explicit bounded cache-retention amount', () => {
    expect(parseCleanupArguments([])).toEqual({ apply: false, buildCache: false, keepStorage: null });
    expect(parseCleanupArguments(['--apply', '--build-cache', '--keep-storage=20GB']))
      .toEqual({ apply: true, buildCache: true, keepStorage: '20GB' });
    expect(() => parseCleanupArguments(['--build-cache'])).toThrow(/supplied together/);
    expect(() => parseCleanupArguments(['--build-cache', '--keep-storage=101GB'])).toThrow(/1GB through 100GB/);
  });
});
