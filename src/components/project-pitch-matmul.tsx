import { Link } from 'react-router-dom';
import { ArrowUpRight } from 'lucide-react';
import { matmul444Profile, type Project } from '@/lib/projects';
import { MatmulReference } from './matmul-reference';

/** The matmul-4x4x4 "About this project" section. */
export function MatmulPitch({ project }: { project: Project }) {
  const context = matmul444Profile.context;
  return <section className="project-about project-pitch" aria-labelledby="project-about-title">
    <p className="eyebrow" id="project-about-title">About this project</p>
    <div className="project-pitch-visual"><MatmulReference referenceOnly /><div className="project-pitch-story">
      <h2>Many experiments.<br />One integer to beat.</h2>
      <div className="project-pitch-background">
        <p>Multiply two 4×4 matrices using as few <strong>scalar products</strong> as possible, with every coefficient an integer. Strassen showed in 1969 that 2×2 needs 7 products instead of 8; applied to 2×2 blocks, that gives 4×4 in 49.</p>
        <p>In 2025 the count fell to 48, first with complex coefficients and then with rational ones that divide by 2. Nobody has done it in 48 with integers, and integer schemes are the ones that work over every ring and in hardware.</p>
        <p>A contribution can be a scheme with fewer products, a check of someone else’s scheme, or an experiment that helps explain which search methods are worth trying next.</p>
      </div>
      <a className="inline-link" href="#project-status">See the project status ↓</a>
    </div></div>
    <div className="project-research-background">
      <section aria-labelledby="matmul-background-title">
        <h3 id="matmul-background-title">A starting point worth building on</h3>
        <p>Motive starts from <strong>Strassen’s 1969 scheme applied recursively</strong>: 49 products, every coefficient −1, 0 or 1. It is constructed by a published script, checked exactly, and cross-checked against an independently published 49-product scheme. Our community’s task is to explore what can be improved from there.</p>
        <p>Best known counts depend on the coefficient ring, so this project says which ring it means on every page and in every report: integers only. A scheme that merely matches a published count is not an improvement.</p>
        <a className="inline-link" href={context.complex.url} target="_blank" rel="noreferrer">Read the AlphaEvolve paper <ArrowUpRight aria-hidden="true" /></a>
      </section>
      <section aria-labelledby="matmul-benchmark-title">
        <h3 id="matmul-benchmark-title">Progress you can measure</h3>
        <p>The score is the number of products in a valid scheme; fewer is better. Motive reconstructs the whole 4×4 multiplication tensor from the submitted U, V and W factors with exact integer arithmetic, so validity is a yes or no with no tolerance.</p>
        <table className="project-context-table"><caption>Best known product counts for 4×4 by coefficient ring, as of 15 September 2026</caption>
          <thead><tr><th scope="col">Ring</th><th scope="col">Products</th><th scope="col">Source</th></tr></thead>
          <tbody>
            {[context.integer, context.rational, context.complex, context.characteristic2].map(row => <tr key={row.ring}><td>{row.ring}</td><td>{row.rank}</td><td><a href={row.url} target="_blank" rel="noreferrer">{row.attribution} ↗</a></td></tr>)}
          </tbody>
        </table>
        <a className="inline-link" href={matmul444Profile.sources.catalogue} target="_blank" rel="noreferrer">Explore the catalogue of fast matrix multiplication algorithms <ArrowUpRight aria-hidden="true" /></a>
      </section>
      <section aria-labelledby="matmul-methods-title">
        <h3 id="matmul-methods-title">Open methods, new experiments</h3>
        <p>Most recent improvements came from flip-graph searches: random walks over equivalent schemes that occasionally shed a product. Open-source implementations exist under MIT and GPL licenses, and DeepMind’s verification notebook is Apache-licensed. Contributors can study those methods, try a different approach, or reproduce an earlier experiment.</p>
        <a className="inline-link" href={matmul444Profile.sources.table} target="_blank" rel="noreferrer">Explore best ranks by ring and an open-source flip-graph toolkit <ArrowUpRight aria-hidden="true" /></a>
      </section>
    </div>
    <div className="about-project-links"><a href="/projects/matmul-4x4x4/reference-provenance.json">Reference & attribution ↗</a><a href="/projects/matmul-4x4x4/reference-witness.json" download>Reference scheme ↓</a><Link to={`/?project=${project.id}&tab=check`}>Check a scheme file ↗</Link></div>
    <p className="project-reference-exact">Reference number of products: <code>{matmul444Profile.reference.rank}</code> · integer coefficients</p>
  </section>;
}
