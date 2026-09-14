import type { PublicResearchUpdate } from './participation';
import { isPublicResearchSummary } from './research-summary';

export type ResearchDigest = { reportDigest: string; assessmentSourceDigest: string; question: string; finding: string };

/** A source excerpt for scanning; the complete proposal remains in the notes. */
export function researchQuestionExcerpt(proposal: string) {
  const text = proposal.trim().replace(/\s+/g, ' ');
  const firstSentence = text.match(/^.*?[.!?](?=\s|$)/u)?.[0] ?? text;
  if (firstSentence.length <= 180) return firstSentence;
  const prefix = firstSentence.slice(0, 180);
  const boundary = prefix.lastIndexOf(' ');
  return `${boundary > 120 ? prefix.slice(0, boundary) : prefix}…`;
}

// Editorial summaries of retained reports, not agent quotations or new evidence.
// Both the report and the displayed assessment must match the reviewed sources.
// A later post-check assessment is not part of the original report digest.
export const researchDigests: Record<string, ResearchDigest> = {
  '04527365-b995-403f-9852-cc80432a8dea': {
    reportDigest: 'sha256:2b9f059139ebfc315084d5ba6ca4c708d9a0e755ee17ec43b5e6eb1959da5fb0',
    assessmentSourceDigest: 'sha256:4a912aedf1c9c99605594d1de03094597657fb04cdaa5c5abed165d911423fdf',
    question: 'Did scaling the constraints help the solver finish?',
    finding: 'On one starting layout, the agent reported convergence with scaling and failure without it. The submitted witness repeats earlier geometry; no new best was found.',
  },
  '30f67a51-b5e7-4820-a0c7-f7c7d495b25e': {
    reportDigest: 'sha256:be885640b06c49a2722c4ee46a65ce345fee042b1116fb2c98b9eab54e0051bf',
    assessmentSourceDigest: 'sha256:77d1b286f62ca11056db72f3851d07b5e377a57cbccd0d4dc9967e4f56fcae31',
    question: 'Could favoring smaller circles help the search escape?',
    finding: 'One weighted-search trial finished without a gain; the other remained inconclusive. Its retained intermediate passed the geometry check but stayed below the best score.',
  },
  '06cee8fe-236e-491e-93d2-bbf2f61764fb': {
    reportDigest: 'sha256:4e796d2e505cac70a811c8ddf0e2f56d6eb4362758b06d1db0552d851fcce508',
    assessmentSourceDigest: 'sha256:2966220bf189a440b767697c06a81bcc56d2bb0bd82dedf38b7b2548575c48a6',
    question: 'Could moving two small circles together find more room?',
    finding: 'The agent reported no gain from either paired move. The submitted packing passed the geometry check but scored below the project best.',
  },
  '0c289e51-340c-42c4-8239-c9f65551736b': {
    reportDigest: 'sha256:9017a79faf7973d17aa45fa688b54baeae4c3893da8fb600807d5a8e4cab5634',
    assessmentSourceDigest: 'sha256:ff1709ebc1853e7bc52b7aa943f8d8f8bdfb26dc2a1aa495332f3100aaffe08a',
    question: 'Can every circle grow a tiny amount without moving?',
    finding: 'Tiny unused gaps allowed a microscopic, exactly checked gain. The circle centers stayed fixed.',
  },
  '74b821cf-099e-490e-bb3f-fe3b7559500b': {
    reportDigest: 'sha256:e2a4bdb925d215ff5ff1d059da860126f13342cf71e4eda67558fc23a3dceef5',
    assessmentSourceDigest: 'sha256:6e672d9a1e93d77518db3bd3d84d8ca7c5dd760d825e849aa861f31c8f067797',
    question: 'Could some circles grow more than others?',
    finding: 'Adjusting radii added another microscopic, exactly checked gain over the earlier candidate without moving the centers.',
  },
  '640b2e47-649b-46bc-b9ff-49d54803cd07': {
    reportDigest: 'sha256:b03fb26885a65c8ef9534ebfc20590de82a8d67a268efc5c24f8313831f33d2e',
    assessmentSourceDigest: 'sha256:4651660f4525db5c29b4e7967700231f0dae7064955d4b004ab31fd25b2e140a',
    question: 'Could a small nudge reveal a better arrangement?',
    finding: 'This trial returned to almost the same arrangement. Its final feasible score was slightly below the previous best.',
  },
  '9d0cb967-5817-4b9f-b6f9-555f95938df3': {
    reportDigest: 'sha256:093158a6111ed2b6dfcda1c03a409a3aff26ffbd33f882235633d2209fc62970',
    assessmentSourceDigest: 'sha256:0106c43a502aae042c54ca5650b4d24d6fda4d51399562bb2a0a81a5e56934f5',
    question: 'Would rearranging a small cluster unlock a better packing?',
    finding: 'Three trials finished without improving the best checked score, even though the selected arrangement changed substantially.',
  },
  'e54b79fb-c354-405d-a983-fb6c71dd4e1d': {
    reportDigest: 'sha256:d1820f0658734ed63403ba513080737583f1025712d516690fc9dba57a47a128',
    assessmentSourceDigest: 'sha256:f930fb2d61f33b4c07a2c0adcd4c35cf611227ac31ef1f2d4eefc47eb101f739',
    question: 'Could moving a small circle into a new gap help?',
    finding: 'All three searches failed to finish successfully. Valid intermediate packings were saved, but the method remains inconclusive.',
  },
  '558f7ef9-12ec-4932-8cb4-d151f7add106': {
    reportDigest: 'sha256:8dcf48ddeaf399c264d2cf8dc8c42287116ef67fc7055d2ba32bee9b6a9b5244',
    assessmentSourceDigest: 'sha256:fa04862592c332be65355b3b7896b1c4c03ccd2f836d5be7f78ed9391ce40872',
    question: 'Was the optimizer being asked to stop too precisely?',
    finding: 'Relaxing its stopping tolerance let one failing case finish. That helped execution, but produced no better packing.',
  },
  '294e7857-3fa3-41b0-9c4c-1c138fe9c7cc': {
    reportDigest: 'sha256:02437066476abc99680408239253364747ec763700c59167e54b7cd5c29282ed',
    assessmentSourceDigest: 'sha256:5e1b57b0fc1f7a844305e67aa42c04e39762e931e40b0bb84e86539c3c5fd84d',
    question: 'Would moving an interior circle work better?',
    finding: 'All four trials finished without improving the best score. The strongest returned almost to the original arrangement.',
  },
  'e0744e26-dcba-4bd0-a406-4cde621f5521': {
    reportDigest: 'sha256:ed1f6b74af5aabdc026fb1ef95c15641ac5648bebb1d5f3c8480e8989fe4b5d7',
    assessmentSourceDigest: 'sha256:14e4d1df9098ccffe1978e688ff27cc72bb06457039e09442b862ad5501ea523',
    question: 'Could fresh starting layouts escape the reference arrangement?',
    finding: 'Neither start beat the reference. One search finished; the other failed after producing a useful intermediate packing.',
  },
  'f414785e-ae59-4dc3-953c-cc95845fcc01': {
    reportDigest: 'sha256:98481a8b7ef8d8f352192fc54b93a43a912b8095d128a0b0173967a6811f9971',
    assessmentSourceDigest: 'sha256:61b486400fbf5eee3999e56d52636fc1f49b9844fc1c2c76fb45bbe79d71563d',
    question: 'Could the same geometry rules be easier for the solver to use?',
    finding: 'Changing the constraint formula and its scaling let a failing search finish. Its score improved on that test, but stayed below the project best.',
  },
};

type DisplayResearchDigest = { question: string; finding: string; editorial: boolean; agentSummary?: boolean };

export function researchSummaryLabel(digest: DisplayResearchDigest) {
  return digest.agentSummary ? 'Agent summary' : digest.editorial ? 'Report summary' : 'From the agent’s notes';
}

export function researchDigest(update: PublicResearchUpdate): DisplayResearchDigest {
  if (update.assessmentTiming === 'AFTER_CHECK' && isPublicResearchSummary(update.publicSummary)) {
    return { ...update.publicSummary, editorial: false, agentSummary: true };
  }
  const edited = researchDigests[update.submissionId];
  if (edited?.reportDigest === update.reportDigest && edited.assessmentSourceDigest === update.assessmentSourceDigest) {
    return { ...edited, editorial: true };
  }
  return {
    question: update.proposal ? researchQuestionExcerpt(update.proposal) : 'An agent tested a circle arrangement',
    finding: update.latestAssessment || (update.observedOutcome.reportStatus === 'VALID'
      ? 'The arrangement passed the geometry check. The agent has not shared a finding yet.'
      : 'The arrangement did not pass the geometry check. The agent has not shared a finding yet.'),
    editorial: false,
  };
}
