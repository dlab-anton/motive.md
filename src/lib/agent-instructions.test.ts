import { describe, expect, it } from 'vitest';
import { agentInstructions, type AgentRunMode } from './agent-instructions';

const ORIGIN = 'https://motive.example';

describe('agent instructions', () => {
  it('keeps the existing three-argument HTTP prompt byte-identical', () => {
    const token = 'fixture-project-access-key';
    const connection = { id: 'connection-17', agentName: 'Robin', token };
    const expected = `Read ${ORIGIN}/agents/SKILL.md and the linked project manifest. Work on Motive's circle-packing project through its documented HTTP API. Follow Propose → Test → Update and the shared work queue.\nRun mode: ONE_TASK. Finish one bounded discovery or peer-validation task, including its retained evidence, post-check update and any ready finding or shared-memory delivery step, then pause. If a live task, pending review or ready delivery exists, finishing it counts as this task. Use only the compute and model resources I have already authorized.\nRecover an existing claim before taking new work. Follow the guide's session check-in and pause instructions so Motive can show your status. Read retained research after each task. Use linked Hypothesis context when available, and explicitly report when it is not linked. Preserve evidence, respect assignment limits, and report the specific reason when you stop.\nUse this project-scoped bearer credential only in the Authorization header when calling ${ORIGIN}/api/agent/:\n${token}\nNever put credentials in a URL, artifact, repository or log.`;

    expect(agentInstructions(ORIGIN, 'ONE_TASK', connection)).toBe(expected);
    expect(agentInstructions(ORIGIN, 'ONE_TASK', connection, 'http')).toBe(expected);
  });

  it('keeps the existing HTTP resume and missing-connection access wording', () => {
    const resume = agentInstructions(ORIGIN, 'THIRTY_MINUTES', { id: 'connection-17', agentName: 'Robin' });
    expect(resume).toContain('Continue the existing Motive agent Robin, connection connection-17. Use its project access key already supplied in this conversation. If it is unavailable, ask me for it; the website cannot restart this application or recover a saved key.');
    expect(agentInstructions(ORIGIN, 'UNTIL_STOPPED')).toContain('\nAsk me for a project access key before claiming an assignment.\n');
  });

  it('keeps MCP credentials in extension settings and verifies the connection projection', () => {
    const token = `motive_agent_${'a'.repeat(32)}_${'b'.repeat(43)}`;
    const prompt = agentInstructions(`${ORIGIN}/`, 'ONE_TASK', {
      id: 'connection-17', agentName: 'Robin', token,
    }, 'mcp');

    expect(prompt).not.toContain(token);
    expect(prompt).not.toContain('/api/agent/');
    expect(prompt).not.toContain('already supplied in this conversation');
    expect(prompt).toContain('installed Motive extension for every Motive call');
    expect(prompt).toContain('read_project_document');
    expect(prompt).toContain('agents/SKILL.md');
    expect(prompt).toContain('agents/circle-packing.json');
    expect(prompt).toContain(`${ORIGIN}/?project=circle-packing`);
    expect(prompt).toContain('credential projection has id connection-17 and agentName Robin');
    expect(prompt).toContain('call get_assignment once before any write to verify the configured agent');
    expect(prompt).toContain("project access key is held in the extension's sensitive settings");
    expect(prompt).toContain('Never ask me to paste or repeat it in chat');
    expect(prompt.indexOf('get_work_queue')).toBeLessThan(prompt.indexOf('get_assignment'));
  });

  it.each<[AgentRunMode, string]>([
    ['ONE_TASK', 'Finish one bounded discovery or peer-validation task, including its retained evidence, post-check update and any ready finding or shared-memory delivery step, then pause. If a live task, pending review or ready delivery exists, finishing it counts as this task.'],
    ['THIRTY_MINUTES', 'Continue bounded discovery and eligible peer validation for up to 30 minutes from starting this run. Leave time to preserve evidence and release unfinished work before the deadline, then pause.'],
    ['UNTIL_STOPPED', 'Continue bounded discovery and eligible peer validation until I stop you, your existing authorized resources end, or a required dependency is unavailable. Do not buy additional resources or exceed the limits of this application.'],
  ])('preserves the %s limit and lifecycle in MCP prompts', (runMode, limit) => {
    const prompt = agentInstructions(ORIGIN, runMode, undefined, 'mcp');
    expect(prompt).toContain(`Run mode: ${runMode}. ${limit}`);
    expect(prompt).toContain('Recover existing work before taking a new claim.');
    expect(prompt).toContain('session check-in and pause instructions with set_session_status');
    expect(prompt).toContain('Read retained and shared research after each task with the extension');
    expect(prompt).toContain('perform any eligible finding review and research sync through the extension');
  });
});
