import { getProject } from './projects.ts';

export const STORAGE_KEY = 'motive-public-projects-v1';
export type SupportState = { following: string[] };
export const emptyState: SupportState = { following: [] };
export type SupportAction = { type: 'follow'; goal: string; following: boolean };

const object = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

export function restoreState(raw: unknown): SupportState {
  if (!object(raw) || !Array.isArray(raw.following)) return emptyState;
  return { following: [...new Set(raw.following.filter((goal): goal is string => typeof goal === 'string' && Boolean(getProject(goal))))] };
}

export function loadState(): SupportState {
  try {
    const raw = localStorage.getItem(STORAGE_KEY) ?? localStorage.getItem('motive-preview-v2') ?? 'null';
    return restoreState(JSON.parse(raw));
  } catch { return emptyState; }
}

export function supportReducer(state: SupportState, action: SupportAction): SupportState {
  if (action.type !== 'follow' || !getProject(action.goal) || typeof action.following !== 'boolean') return state;
  const following = action.following
    ? [...new Set([...state.following, action.goal])]
    : state.following.filter(goal => goal !== action.goal);
  return following.length === state.following.length && following.every((goal, index) => goal === state.following[index])
    ? state : { following };
}

export function applySupportAction(state: SupportState, action: SupportAction): SupportState {
  return supportReducer(state, action);
}
