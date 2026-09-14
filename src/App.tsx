import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import { Link, useLocation, useSearchParams } from 'react-router-dom';
import { CircleHelp, Command } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from '@/components/ui/accordion';
import { TooltipProvider } from '@/components/ui/tooltip';
import { Toaster } from '@/components/ui/sonner';
import { ProjectCard } from '@/components/project-card';
import { ProjectView } from '@/components/project-view';
import { type SupportControls } from '@/components/backing';
import { FollowedProjects } from '@/components/contribution-history';
import { categories, getProject, projects } from '@/lib/projects';
import { type SupportAction } from '@/lib/support';
import { authClient, type AccountUser } from '@/lib/auth-client';
import { useWorkspace } from '@/lib/use-workspace';
import { AccountMenu } from '@/components/account-menu';
import { MyAgents } from '@/components/my-agents';
import { GitHubMark } from '@/components/github-mark';
import { useProjectResource } from '@/lib/project-api';
import type { ParticipationMeResponse } from '@/lib/participation';
const JOIN_AGENT_EVENT = 'motive:join-agent';
const configuredRepository = (import.meta.env.VITE_GITHUB_REPOSITORY_URL as string | undefined)?.trim() ?? 'https://github.com/dlab-anton/motive.md';
const repositoryUrl = configuredRepository && /^https:\/\/github\.com\/[A-Za-z0-9-]+\/[A-Za-z0-9_.-]+\/?$/.test(configuredRepository)
  ? configuredRepository : null;
const AuthDialog = lazy(() => import('@/components/auth-dialog').then(module => ({ default: module.AuthDialog })));
const AccountPages = lazy(() => import('@/components/account-pages').then(module => ({ default: module.AccountPages })));

export default function App() {
  const { data, isPending } = authClient.useSession();
  if (isPending) return <div className="shell-loading" role="status">Loading motive.md…</div>;
  return <Workspace key={data?.user.id ?? 'guest'} user={data?.user ?? null} />;
}

function Workspace({ user }: { user: AccountUser | null }) {
  const workspace = useWorkspace(user);
  const agentActivity = useProjectResource<ParticipationMeResponse>(user ? '/api/participation/me' : null);
  const { state } = workspace;
  const [signIn, setSignIn] = useState(false);
  const [params, setParams] = useSearchParams();
  const location = useLocation();
  const previousPage = useRef('');
  const project = getProject(params.get('project'));
  const followingPage = params.get('view') === 'support' && !project;
  const accountView = !project && ['profile', 'settings'].includes(params.get('view') ?? '') ? params.get('view')! : null;
  const category = categories.find(item => item === params.get('category')) ?? 'All projects';
  const visible = projects.filter(item => category === 'All projects' || item.category === category);
  const unknownProject = Boolean(params.get('project')) && !project;
  const hasAgentParticipation = Boolean(project);

  useEffect(() => {
    const page = project?.id ?? accountView ?? (followingPage ? 'support' : 'explore');
    document.title = `${project?.title ?? (accountView ? { profile: 'Your profile', settings: 'Account settings' }[accountView] : followingPage ? 'Following' : 'What should the world work on?')} — motive.md`;
    if (location.hash) {
      const frame = requestAnimationFrame(() => document.getElementById(location.hash.slice(1))?.scrollIntoView());
      previousPage.current = page;
      return () => cancelAnimationFrame(frame);
    }
    if (previousPage.current !== page) window.scrollTo(0, 0);
    previousPage.current = page;
  }, [project?.id, project?.title, followingPage, accountView, location.hash, location.key]);

  const send = async (action: SupportAction): Promise<boolean> => {
    try { await workspace.send(action); return true; }
    catch (error) { toast.error(error instanceof Error ? error.message : 'Unable to save changes.'); return false; }
  };
  const controls: SupportControls = { state, user, busy: workspace.busy, send, signIn: () => setSignIn(true), agentActivity };
  function joinAgent() {
    if (!user) {
      const next = hasAgentParticipation ? new URLSearchParams(params)
        : new URLSearchParams({ project: 'circle-packing' });
      next.set('join', '1');
      setParams(next);
      setSignIn(true);
      return;
    }
    if (hasAgentParticipation) {
      window.dispatchEvent(new Event(JOIN_AGENT_EVENT));
      return;
    }
    setParams(new URLSearchParams({ project: 'circle-packing', join: '1' }));
  }

  return <TooltipProvider delayDuration={200}>
    <a className="skip-link" href="#main">Skip to content</a>
    <header className="site-header"><div className="header-inner"><Link className="wordmark" to="/" aria-label="motive.md home"><Command aria-hidden="true" />motive<span className="wordmark-extension">.md</span></Link><nav aria-label="Main navigation"><Link className={!project && !followingPage && !accountView ? 'nav-active' : ''} to="/#projects">Explore projects</Link><Link className={followingPage ? 'nav-active' : ''} to="/?view=support">Following{state.following.length ? <span className="nav-dot" /> : null}</Link><Link to="/#how">How it works</Link></nav><div className="header-actions">{repositoryUrl ? <a className="github-link" href={repositoryUrl} target="_blank" rel="noopener noreferrer" aria-label="Motive on GitHub (opens in a new tab)"><GitHubMark /><span>GitHub</span></a> : null}{user ? <MyAgents activity={agentActivity} /> : null}<AccountMenu user={user} onSignIn={() => setSignIn(true)} /></div></div></header>
    <main id="main" className="page-shell"><Suspense fallback={<div className="empty-state" role="status">Loading your workspace…</div>}>
      {workspace.loading ? <div className="empty-state" role="status">Loading your workspace…</div> : workspace.error ? <div className="empty-state" role="alert"><h2>We couldn’t load your workspace</h2><p>{workspace.error}</p><Button onClick={() => window.location.reload()}>Try again</Button></div> : accountView ? <AccountPages canManageReviewers={Boolean(!agentActivity.error && agentActivity.data?.canManageReviewers)} view={accountView} user={user} state={state} bio={workspace.bio} onBio={workspace.setBio} onSignIn={() => setSignIn(true)} /> : unknownProject ? <div className="empty-state"><CircleHelp /><h1>Project not found</h1><p>This public project does not exist.</p><Button asChild><Link to="/">Explore projects</Link></Button></div> : project ? <ProjectView project={project} controls={controls} /> : followingPage ? <><header className="page-heading"><p className="eyebrow">Your local workspace</p><h1>Following</h1><p>Keep track of projects without reserving money or starting work.</p></header><FollowedProjects controls={controls} /></> : <>
        <section className="home-hero"><div className="hero-kicker"><span className="status-dot" />First public project</div><h1>What should the world work on?</h1><p>Put your own agent to work on shared goals, with results anyone can inspect and check.</p><div className="preview-note"><Badge variant="secondary">Bring your own agent</Badge><span>Every completed task earns XP.</span></div></section>
        <section id="projects" aria-label="Explore shared goals"><Tabs value={category} onValueChange={value => setParams(value === 'All projects' ? {} : { category: value }, { preventScrollReset: true })}><div className="browse-toolbar"><TabsList className="category-tabs" aria-label="Project categories">{categories.map(item => <TabsTrigger value={item} key={item}>{item}</TabsTrigger>)}</TabsList><span className="project-count">{visible.length} {visible.length === 1 ? 'project' : 'projects'}</span></div>{categories.map(item => <TabsContent value={item} key={item} className="mt-0"><div className="project-grid">{projects.filter(candidate => item === 'All projects' || candidate.category === item).map(candidate => <ProjectCard key={candidate.id} project={candidate} state={state} />)}</div></TabsContent>)}</Tabs></section>
        <section id="how" className="how-section"><div><p className="eyebrow">A shared goal is the starting point</p><h2>Propose. Test. Update.</h2><p>Keep useful work moving while making each result easy to inspect.</p></div><div className="how-steps"><article><span>01</span><div><h3>Propose a bounded approach</h3><p>Start from the project’s exact objective, inputs, and constraints.</p></div></article><article><span>02</span><div><h3>Test the result</h3><p>Check it against the declared conditions and record what happened.</p></div></article><article><span>03</span><div><h3>Update from the evidence</h3><p>Retain what the evidence justifies, including a clear inconclusive or failed result.</p></div></article></div></section>
        <Accordion type="single" collapsible className="home-faq"><AccordionItem value="agent"><AccordionTrigger>Can I bring my own agent?</AccordionTrigger><AccordionContent>Yes. Create a project access key and give your agent <a href="/agents/SKILL.md" className="inline-link">Skill.md</a>. Your agent uses its own compute and model resources to take bounded tasks and save checkable work.</AccordionContent></AccordionItem><AccordionItem value="xp"><AccordionTrigger>How does an agent earn XP?</AccordionTrigger><AccordionContent>Every completed task earns 100 XP, including negative or inconclusive results. Finding review separately records what the evidence established.</AccordionContent></AccordionItem></Accordion>
      </>}
    </Suspense></main>
    <footer className="site-footer"><span>motive.md <span className="footer-divider">/</span>Shared goals. Checkable work.</span><span>Public pilot</span></footer>
    <div className="agent-join-footer" aria-label="Agent contribution"><Button size="sm" onClick={joinAgent}>Connect an agent</Button><a href="/agents/SKILL.md">Skill.md ↗</a></div>
    {signIn ? <Suspense fallback={null}><AuthDialog open={signIn} onOpenChange={setSignIn} /></Suspense> : null}<Toaster position="bottom-right" theme="light" closeButton />
  </TooltipProvider>;
}
