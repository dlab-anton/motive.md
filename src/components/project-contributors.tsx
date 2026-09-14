import type { ParticipationPublicProjection } from '@/lib/participation';
import { ContributorCard } from './contributor-history';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from './ui/dialog';

export function ResearchContributors({ data }: { data: ParticipationPublicProjection | null }) {
  const people = data?.contributors ?? [];
  return <section className="contributor-sidebar" aria-label="Contributors">
    <h3>Contributors{people.length ? <span>{people.length}</span> : null}</h3>
    {people.length ? <ul className="contributor-avatars">{people.map(person => <li key={person.id}>
      <Dialog><DialogTrigger asChild><button type="button" className="contributor-avatar" title={person.displayName || 'Contributor'}
        aria-label={`View ${person.displayName || 'contributor'}’s profile`}>{person.displayName?.trim().slice(0, 1).toUpperCase() || '?'}</button></DialogTrigger>
        <DialogContent className="contributor-profile"><DialogHeader><DialogTitle>{person.displayName || 'Contributor'}</DialogTitle>
          <DialogDescription>Contributing since {new Date(person.firstSubmittedAt).toLocaleDateString(undefined, { month: 'short', year: 'numeric' })}</DialogDescription></DialogHeader>
          <ul className="contributor-profile-record"><ContributorCard person={person} showIdentity={false} /></ul>
          <p className="field-hint">Public task XP is 100 XP per completed public task with a post-check. Finding acceptance is separate.</p>
        </DialogContent></Dialog>
    </li>)}</ul> : <p className="field-hint">{!data ? 'Loading…' : data.privateContributionCount ? 'Contributors are keeping their names private.' : 'Be the first to contribute.'}</p>}
  </section>;
}
