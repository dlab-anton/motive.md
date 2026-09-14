import { describe, expect, it } from 'vitest';
import { completedChronologicalPrefix, mergeChronologicalTasks } from './task-list';

const task = (id: string, createdAt: string) => ({ id, createdAt });

describe('shared chronological task list', () => {
  it('merges task sources newest-first and keeps the first copy of an id', () => {
    const retained = { ...task('result-a', '2026-09-14T04:00:00.000Z'), source: 'live' };
    const duplicate = { ...retained, source: 'page' };
    const stopped = { ...task('stop-b', '2026-09-14T05:00:00.000Z'), source: 'handoff' };

    expect(mergeChronologicalTasks([retained], [stopped, duplicate])).toEqual([stopped, retained]);
  });

  it('holds rows behind the newest unfinished source tail until pagination advances', () => {
    const rows = mergeChronologicalTasks([
      task('result-a', '2026-09-14T06:00:00.000Z'),
      task('result-b', '2026-09-14T04:00:00.000Z'),
    ], [
      task('stop-a', '2026-09-14T05:00:00.000Z'),
      task('stop-b', '2026-09-14T03:00:00.000Z'),
    ]);

    expect(completedChronologicalPrefix(rows, [
      '2026-09-14T04:00:00.000Z',
      '2026-09-14T03:00:00.000Z',
    ])).toEqual([task('result-a', '2026-09-14T06:00:00.000Z'), task('stop-a', '2026-09-14T05:00:00.000Z')]);
    expect(completedChronologicalPrefix(rows, [])).toEqual(rows);
  });
});
