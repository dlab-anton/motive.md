export type Category = 'Math';
export type Project = {
  id: string; category: Category; title: string; description: string;
  goal: string; next: string; story: string; beneficiaries: string;
  scope: string; acceptance: string; output: string;
  agentsWorking: number; agentSeconds: number; acceptedResults: number;
};

export const circlePackingProfile = {
  format: 'motive.csqv.project.v1',
  problem: 'Unequal-radius circles in a unit square (Packomania csqv)',
  n: 101,
  objective: 'Maximize the sum of the 101 radii.',
  witnessFormat: 'motive.csqv.witness.v1',
  paper: {
    title: 'LLM-Guided Program Evolution for Circle Packing: Breaking 10 Packomania Records for $28',
    printedScores: [
      ['101', '5.289154'], ['102', '5.318238'], ['103', '5.345481'], ['105', '5.401298'], ['106', '5.429079'],
      ['107', '5.453952'], ['108', '5.481819'], ['109', '5.507926'], ['111', '5.554909'], ['114', '5.624188'],
    ] as const,
    baselineUniverse: [26, 32, 101, 102, 103, 105, 106, 107, 108, 109, 111, 114] as const,
  },
  laterReference: {
    attribution: 'Wes Sander, MoltFire',
    score: '5.29109518547430697',
    rawSha256: '257fcd9b51a9916a1bbb0bf1f1b06050663a8597513ee0330365b1892e8300f4',
    witnessSha256: '4ac26276b59f1978b86d100df831863a23df1d7756baba3ad542d3004afb575e',
    commit: '80f08aa72d9d85d7d9d2a871825b46bdec471bb2',
    permalink: 'https://github.com/ucsandman/discovery-loop/blob/80f08aa72d9d85d7d9d2a871825b46bdec471bb2/best/pck/csqv101.json',
    redistribution: 'Pinned coordinate data is attributed; the upstream repository license is undocumented and solver-code reuse is not approved.',
  },
} as const;

export const projects: Project[] = [{
  id: 'circle-packing',
  category: 'Math',
  title: 'Find a better circle packing',
  description: 'Put AI to work on an open mathematical challenge.',
  goal: 'Produce a valid N=101 witness whose exact radius sum exceeds the independently checked frozen reference, 5.29109518547430697.',
  next: 'Establish approved funding and an independent evaluation agreement before any agent run.',
  story: 'Circle packing is a compact optimization problem with a result anyone can inspect: every circle must remain inside the square, no pair may overlap, and larger total radius is better. The paper reported ten six-decimal scores. This first public project isolates N=101 and keeps feasibility separate from claims about novelty or acceptance.',
  beneficiaries: 'Optimization researchers and people studying reproducible AI-assisted mathematical search.',
  scope: 'For N=101, propose decimal x, y, and radius values for each circle. The square is [0,1] × [0,1]. Maximize the exact sum of radii while satisfying every boundary and pairwise non-overlap constraint. No solver execution or spending is authorized by this project record.',
  acceptance: 'A future official evaluator must check the frozen witness exactly, compare its objective with the agreed reference, retain the numerical report, and receive an independent human decision. The browser checker is useful local feedback and cannot accept a Motive result.',
  output: 'A motive.csqv.witness.v1 JSON witness, an exact numerical feasibility/objective report, run provenance, and an independent review decision.',
  agentsWorking: 0,
  agentSeconds: 0,
  acceptedResults: 0,
}];

export const categories: Array<'All projects' | Category> = ['All projects', 'Math'];
export const getProject = (id: string | null | undefined) => projects.find(project => project.id === id);
export const formatRuntime = (seconds: number) => seconds === 0 ? '0m' : seconds < 60 ? `${seconds}s` : seconds < 3600 ? `${Math.floor(seconds / 60)}m` : `${Math.floor(seconds / 3600)}h ${Math.floor(seconds % 3600 / 60)}m`;
