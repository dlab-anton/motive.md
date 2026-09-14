export type ChronologicalTask = {
  id: string;
  createdAt: string;
};

/** Keep the first copy of each record and order the shared task timeline newest-first. */
export function mergeChronologicalTasks<T extends ChronologicalTask>(...groups: T[][]): T[] {
  const seen = new Set<string>();
  return groups.flatMap(group => group.filter(item => {
    if (seen.has(item.id)) return false;
    seen.add(item.id);
    return true;
  })).sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt)
    || right.id.localeCompare(left.id));
}

/**
 * Rows at or below an unfinished source's loaded tail may have unseen records
 * ahead of them. Hold that suffix until the source advances or reaches its end.
 */
export function completedChronologicalPrefix<T extends ChronologicalTask>(items: T[], unfinishedTails: string[]): T[] {
  if (!unfinishedTails.length) return items;
  const boundary = Math.max(...unfinishedTails.map(value => Date.parse(value)));
  return items.filter(item => Date.parse(item.createdAt) > boundary);
}
