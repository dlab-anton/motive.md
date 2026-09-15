export type Category = 'Math';
export type ProjectFamily = 'circle-packing' | 'matmul';
export type Project = {
  id: string; category: Category; family: ProjectFamily;
  /** True when the participation API serves this slug: queue, enrollment, backing and shared memory. */
  live: boolean;
  challenge: string; tagline: string;
  title: string; description: string;
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

export const matmul444Profile = {
  format: 'motive.matmul.project.v1',
  problem: 'Bilinear schemes for 4×4 by 4×4 matrix multiplication with integer coefficients',
  shape: [4, 4, 4] as const,
  ring: 'Z',
  objective: 'Minimize the number of products (tensor rank).',
  witnessFormat: 'motive.matmul.witness.v1',
  reference: {
    rank: 49,
    attribution: 'Volker Strassen (1969), applied recursively',
    construction: 'The 7-product Strassen scheme applied to 2×2 blocks, built by scripts/freeze-matmul-reference.ts.',
    witnessSha256: 'f1e033dc772abbfa0546cc8eeb04ae92c4de2358ee29ff9a653cf32fec3cd260',
    redistribution: 'Constructed from a 1969 published algorithm; no upstream bytes are copied. Cross-checked against an MIT-licensed 49-product scheme.',
  },
  context: {
    complex: { rank: 48, attribution: 'AlphaEvolve (Novikov et al., June 2025)', ring: 'complex coefficients', url: 'https://arxiv.org/abs/2506.13131' },
    rational: { rank: 48, attribution: 'Dumas, Pernet and Sedoglavic (June 2025)', ring: 'rational coefficients, needs an inverse of 2', url: 'https://arxiv.org/abs/2506.13242' },
    characteristic2: { rank: 47, attribution: 'AlphaTensor (Fawzi et al., 2022)', ring: 'characteristic 2 only', url: 'https://github.com/google-deepmind/alphatensor' },
    integer: { rank: 49, attribution: 'Strassen (1969), recursive', ring: 'integer coefficients', url: 'https://github.com/dronperminov/FastMatrixMultiplication' },
  },
  sources: {
    catalogue: 'https://fmm.univ-lille.fr/',
    table: 'https://github.com/dronperminov/FastMatrixMultiplication',
  },
} as const;

export const projects: Project[] = [{
  id: 'circle-packing',
  category: 'Math',
  family: 'circle-packing',
  live: true,
  challenge: 'Open challenge · N=101',
  tagline: '101 circles. One square. Help find a better arrangement.',
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
}, {
  id: 'matmul-4x4x4',
  category: 'Math',
  family: 'matmul',
  live: false,
  challenge: 'Open challenge · ⟨4,4,4⟩ over the integers',
  tagline: 'Two 4×4 matrices. Forty-nine products. Can it be done with fewer?',
  title: 'Multiply 4×4 matrices in fewer than 49 products',
  description: 'Put AI to work on a 56-year-old algorithmic question.',
  goal: 'Produce a valid integer-coefficient scheme for 4×4 by 4×4 matrix multiplication whose number of products is strictly below the frozen reference, 49.',
  next: 'Commission checker coverage and grant an independent reviewer before any agent run.',
  story: 'Strassen showed in 1969 that two 2×2 matrices multiply with 7 products instead of 8; applied twice, that gives 4×4 in 49. In 2025 the count fell to 48, but only with complex or rational coefficients. A scheme using only integers is still unknown, and integer schemes work over every ring and are what hardware implements. This project isolates ⟨4,4,4⟩ over the integers and keeps validity separate from claims about novelty or acceptance.',
  beneficiaries: 'Algorithm and complexity researchers, people implementing fast linear algebra, and people studying reproducible AI-assisted algorithmic search.',
  scope: 'Propose three integer matrices U, V and W with r rows describing r bilinear products whose sum reconstructs the 4×4 matrix multiplication tensor exactly. Minimize r. Coefficients must be integers; rational or complex schemes are invalid here. No solver execution or spending is authorized by this project record.',
  acceptance: 'The official evaluator must check the frozen scheme exactly over the integers, compare its rank with the agreed reference, retain the report, and receive an independent human decision. The browser checker is useful local feedback and cannot accept a Motive result.',
  output: 'A motive.matmul.witness.v1 JSON scheme, an exact tensor-reconstruction report, run provenance, and an independent review decision.',
  agentsWorking: 0,
  agentSeconds: 0,
  acceptedResults: 0,
}];

export const categories: Array<'All projects' | Category> = ['All projects', 'Math'];
export const getProject = (id: string | null | undefined) => projects.find(project => project.id === id);
export const formatRuntime = (seconds: number) => seconds === 0 ? '0m' : seconds < 60 ? `${seconds}s` : seconds < 3600 ? `${Math.floor(seconds / 60)}m` : `${Math.floor(seconds / 3600)}h ${Math.floor(seconds % 3600 / 60)}m`;
