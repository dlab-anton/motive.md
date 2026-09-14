import { resolveAgentMcp, type AgentMcpSettings } from '../../runner-codex/src/mcp.ts';
import type { EgressRule } from './types.ts';

/** Include these rules in the reviewed profile before freezing its launch plan. */
export function agentMcpEgress(settings: AgentMcpSettings, agentId: string): EgressRule[] {
  return Object.values(resolveAgentMcp(settings, agentId).servers).flatMap(server => server.transport === 'http'
    ? [{ url: server.url, methods: ['GET', 'POST', 'DELETE'], pathMatch: 'exact' } satisfies EgressRule]
    : []);
}
