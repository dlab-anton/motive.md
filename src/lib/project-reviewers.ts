import type { PARTICIPATION_PROJECT_SLUG } from './participation';

export type ProjectReviewers = {
  format: 'motive.project-reviewers/0.1';
  projectSlug: typeof PARTICIPATION_PROJECT_SLUG;
  reviewers: Array<{ accountId: string }>;
};

export type ProjectReviewerChange = {
  format: 'motive.project-reviewer-change/0.1';
  projectSlug: typeof PARTICIPATION_PROJECT_SLUG;
  accountId: string;
  action: 'GRANT' | 'REMOVE';
  changed: boolean;
  replayed: boolean;
};
