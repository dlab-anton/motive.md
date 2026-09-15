import { createContext, useContext } from 'react';
import { circlePackingProfile, matmul444Profile } from './projects';

/** The first public project keeps its historical, unprefixed account routes. */
export const DEFAULT_PROJECT_SLUG = 'circle-packing';

export type ProjectFamilyKey = 'circle-packing' | 'matmul';

export const projectFamilyOf = (slug: string): ProjectFamilyKey => slug === 'matmul-4x4x4' ? 'matmul' : 'circle-packing';

/** Which live project the components on a page belong to. Defaults to the first project outside a project page. */
export const ProjectSlugContext = createContext<string>(DEFAULT_PROJECT_SLUG);
export const useProjectSlug = () => useContext(ProjectSlugContext);

export const publicProjectPath = (slug: string, path = '') => `/api/public/projects/${slug}${path}`;
export const accountProjectPath = (slug: string, path = '') => slug === DEFAULT_PROJECT_SLUG
  ? `/api/participation${path}` : `/api/participation/projects/${slug}${path}`;
export const projectLink = (slug: string, suffix = '') => `/?project=${slug}${suffix}`;
export const skillPath = (slug: string) => slug === DEFAULT_PROJECT_SLUG ? '/agents/SKILL.md' : `/agents/${slug}/SKILL.md`;

export type ProjectWords = {
  objective: string; artifact: string; report: string; checkValid: string; checkRejected: string; checkTitle: string;
  submitted: string; checkScope: string; figure: string; improvement: string; referenceScore: string;
  direction: 'MAXIMIZE' | 'MINIMIZE'; goalMet: string;
};

const circleWords: ProjectWords = {
  objective: 'Exact sum of radii', artifact: 'Circle positions and sizes', report: 'Exact geometry check',
  checkValid: 'Valid geometry', checkRejected: 'Rejected geometry', checkTitle: 'Geometry check; finding acceptance is separate',
  submitted: 'Submitted packing', checkScope: 'This check covers the submitted coordinates. Trial results may contain other packings.',
  figure: 'Circle arrangement', improvement: 'A valid candidate above the reference',
  referenceScore: circlePackingProfile.laterReference.score, direction: 'MAXIMIZE', goalMet: 'Priority review · Better packing found',
};

const matmulWords: ProjectWords = {
  objective: 'Exact number of products', artifact: 'Scheme factors (U, V, W)', report: 'Exact tensor check',
  checkValid: 'Valid scheme', checkRejected: 'Rejected scheme', checkTitle: 'Tensor check; finding acceptance is separate',
  submitted: 'Submitted scheme', checkScope: 'This check covers the submitted factor matrices. Trial results may contain other schemes.',
  figure: 'Scheme sign pattern', improvement: 'A valid scheme with fewer products than the reference',
  referenceScore: String(matmul444Profile.reference.rank), direction: 'MINIMIZE', goalMet: 'Priority review · Fewer products found',
};

/** Wording that differs between checker families; everything structural stays shared. */
export const projectWords = (slug: string): ProjectWords => projectFamilyOf(slug) === 'matmul' ? matmulWords : circleWords;
