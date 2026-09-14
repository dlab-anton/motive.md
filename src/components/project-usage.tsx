import type { PublicCircleProjectUsage } from '@/lib/project-runs';
import { useProjectResource } from '@/lib/project-api';
import { projectUsagePollInterval } from '@/lib/project-resource-policy';

export function ProjectUsage() {
  const usage = useProjectResource<PublicCircleProjectUsage>('/api/public/projects/circle-packing/usage', { intervalMs: projectUsagePollInterval });
  const counts = usage.data?.hostedGateway;
  const onlyExternal = Boolean(usage.data?.externalAgents.submissions && counts?.gatewayRequests === 0);
  return <div className="project-usage" aria-label="Project model usage"><div><span>{onlyExternal ? 'Outside-agent model tokens' : 'Motive-metered model tokens'}</span><strong>{onlyExternal ? 'Not reported' : counts ? BigInt(counts.recordedTotalTokens).toLocaleString() : '—'}</strong></div>
    <p>{usage.error ? 'Usage could not be refreshed.' : !counts ? 'Checking recorded usage…' : onlyExternal ? 'Connected agents use their own model accounts. Motive can verify their submitted work, but cannot read those accounts’ input or output usage.' : `${counts.inputBreakdownComplete ? BigInt(counts.recordedInputTokens).toLocaleString() : 'Partly reported'} input · ${counts.outputBreakdownComplete ? BigInt(counts.recordedOutputTokens).toLocaleString() : 'partly reported'} output${counts.complete ? '' : ' · partial usage record'}`}</p>
    {!onlyExternal && usage.data?.externalAgents.submissions ? <p>Outside-agent model tokens are not reported and are excluded from this number.</p> : null}
    <details><summary>What this includes</summary><p>These are tokens reported through Motive’s model gateway. Outside agents’ model usage is not reported to Motive and is excluded.</p><p>No project-wide token ceiling is configured. Funded attempts still require their own finite budget and authorization.</p>{counts && !counts.complete ? <p>{counts.unresolvedRequests} requests unresolved; {counts.requestsWithoutTokenCounts} settled requests have no complete token count.</p> : null}</details>
  </div>;
}
