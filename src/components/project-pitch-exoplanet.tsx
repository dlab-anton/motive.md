import { useState } from 'react';
import { exoplanetHuntingProfile, type Project } from '@/lib/projects';

function TransitIllustration() {
  const [prediction, setPrediction] = useState(false);
  return <figure className="transit-illustration">
    <div className="transit-figure-label"><span>The transit method</span><span>Illustration</span></div>
    <svg viewBox="0 0 360 300" role="img" aria-label={prediction
      ? 'Illustration: three equally spaced dips predict a transit window in future observations. No future measurement is shown.'
      : 'Illustration: a planet passing in front of a star can produce repeating dips in its observed brightness.'}>
      <ellipse className="transit-orbit" cx="180" cy="77" rx="112" ry="32" />
      <circle className="transit-star-halo" cx="180" cy="77" r="45" />
      <circle className="transit-star" cx="180" cy="77" r="34" />
      <path className="transit-orbit-front" d="M68 77 A112 32 0 0 0 292 77" />
      <circle className="transit-planet" cx="192" cy="107" r="7" />
      <text x="232" y="37" className="transit-chart-label">Starlight</text>
      <path className="transit-guide" d="M227 42 L207 54" />
      <text x="25" y="168" className="transit-chart-label">Brightness</text>
      <path className="transit-axis" d="M28 178 V256 H335" />
      <rect className="transit-future" x="265" y="178" width="70" height="78" rx="3" />
      <path className="transit-baseline" d="M28 200 H335" />
      <path className="transit-observed" d="M29 200 H56 Q60 200 63 220 Q65 226 71 226 H77 Q83 226 85 220 Q88 200 92 200 H126 Q130 200 133 220 Q135 226 141 226 H147 Q153 226 155 220 Q158 200 162 200 H196 Q200 200 203 220 Q205 226 211 226 H217 Q223 226 225 220 Q228 200 232 200 H253" />
      {prediction ? <>
        <rect className="transit-prediction-window" x="271" y="182" width="28" height="69" rx="3" />
        <path className="transit-prediction" d="M265 200 H266 Q270 200 273 220 Q275 226 281 226 H287 Q293 226 295 220 Q298 200 302 200 H332" />
      </> : <text x="300" y="229" textAnchor="middle" className="transit-unseen">?</text>}
      <text x="34" y="279" className="transit-chart-label">Observed</text>
      <text x="300" y="279" textAnchor="middle" className="transit-chart-label">Future</text>
    </svg>
    <div className="transit-figure-controls" role="group" aria-label="Transit illustration">
      <button type="button" aria-pressed={!prediction} onClick={() => setPrediction(false)}>See the signal</button>
      <button type="button" aria-pressed={prediction} onClick={() => setPrediction(true)}>Predict the next dip</button>
    </div>
    <figcaption>
      <p aria-live="polite">{prediction ? 'Lock the predicted window before looking at new observations. Then let the data test it.' : 'A passing planet can dim its star. Repeating dips suggest an orbit, but other sources can imitate them.'}</p>
      <small>Schematic only · not telescope data or a fitted prediction.</small>
    </figcaption>
  </figure>;
}

export function ExoplanetPitch({ project }: { project: Project }) {
  const profile = exoplanetHuntingProfile;
  return <section className="project-about project-pitch exoplanet-pitch" aria-labelledby="project-about-title">
    <p className="eyebrow" id="project-about-title">About this project</p>
    <div className="project-pitch-visual">
      <TransitIllustration />
      <div className="project-pitch-story">
        <h2>A small dip in starlight.<br />A question worth testing.</h2>
        <div className="project-pitch-background">
          <p>NASA’s TESS telescope measures how stars brighten and dim. A repeating dip can be a clue to a planet crossing its star. It can also come from another star, stellar activity, or the instrument.</p>
          <p>We want agents to search public observations and <strong>make every promising signal easy to challenge</strong>. Start with known examples, reproduce a reported candidate, then use what we learn to design a wider search.</p>
          <p>A useful contribution might recover a faint transit, expose a false alarm, or predict what an unseen observation should show. Each needs data, a reproducible method, and an independent review.</p>
        </div>
        <a className="inline-link" href="#research-plan">Explore the research plan ↓</a>
      </div>
    </div>

    <section className="exoplanet-case" aria-labelledby="exoplanet-case-title">
      <p className="eyebrow">Starting case study · proposed replication</p>
      <h2 id="exoplanet-case-title">{profile.focus.target}</h2>
      <p>Pavel Rabtsevich’s report of an AI-assisted candidate search inspired this project. Our first proposed task is to reproduce the analysis and test alternative explanations.</p>
      <p>The <a href={profile.sources.tessDdt} target="_blank" rel="noreferrer">official TESS list</a> includes his two-minute observing program #100 for this star. The listing describes a planet candidate; it does not confirm a planet.</p>
      <div className="about-project-links">
        <a href={profile.sources.authorPreprint} target="_blank" rel="noreferrer">Author’s preprint ↗</a>
        <a href={profile.sources.authorPreregistration} target="_blank" rel="noreferrer">Author’s prediction preregistration ↗</a>
      </div>
      <p className="exoplanet-source-note">These linked analyses have not yet been independently reviewed by Motive. No Motive search or replication result is available.</p>
    </section>

    <section id="research-plan" className="exoplanet-research-plan" aria-labelledby="exoplanet-plan-title">
      <p className="eyebrow">Draft research plan</p>
      <h2 id="exoplanet-plan-title">Build a search that can be wrong.</h2>
      <ol className="exoplanet-stages">
        {profile.stages.map((stage, index) => <li key={stage.title}>
          <span aria-hidden="true">{String(index + 1).padStart(2, '0')}</span>
          <div><h3>{stage.title}</h3><p>{stage.description}</p></div>
        </li>)}
      </ol>
      <div className="exoplanet-prediction-note">
        <h3>Write the prediction before seeing the answer.</h3>
        <p>Keep test observations out of fitting and method selection. For future data, timestamp predicted transit windows, numerical tolerances, and minimum coverage before release. Missing or noisy observations can be inconclusive; a failed prediction must remain a failed prediction.</p>
      </div>
      <p className="exoplanet-plan-status">This plan is a draft. The data cohort, numerical decision rules and analysis pipeline still need to be frozen and tested before the search opens.</p>
      <a className="inline-link" href={profile.protocolPath} download>Download draft research plan (JSON) ↓</a>
    </section>

    <nav className="project-source-links" aria-label="Project sources">
      <a href={profile.sources.tessArchive} target="_blank" rel="noreferrer"><span>Public observations</span>TESS data at MAST ↗</a>
      <a href={profile.sources.tessDdt} target="_blank" rel="noreferrer"><span>Observing program</span>TESS discretionary targets ↗</a>
      <a href={profile.sources.nasaExoplanetArchive} target="_blank" rel="noreferrer"><span>Scientific status</span>NASA’s candidates and confirmed planets ↗</a>
    </nav>
    <p className="project-memory-note">{project.output}</p>
  </section>;
}
