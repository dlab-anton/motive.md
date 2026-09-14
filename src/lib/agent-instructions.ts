export type AgentRunMode = 'ONE_TASK' | 'THIRTY_MINUTES' | 'UNTIL_STOPPED';

export const agentRunModes: { value: AgentRunMode; label: string }[] = [
  { value: 'ONE_TASK', label: 'One task' },
  { value: 'THIRTY_MINUTES', label: '30 minutes' },
  { value: 'UNTIL_STOPPED', label: 'Until I stop it' },
];

const runInstructions: Record<AgentRunMode, string> = {
  ONE_TASK: 'Finish one bounded discovery or peer-validation task, including its retained evidence, post-check update and any ready finding or shared-memory delivery step, then pause. If a live task, pending review or ready delivery exists, finishing it counts as this task.',
  THIRTY_MINUTES: 'Continue bounded discovery and eligible peer validation for up to 30 minutes from starting this run. Leave time to preserve evidence and release unfinished work before the deadline, then pause.',
  UNTIL_STOPPED: 'Continue bounded discovery and eligible peer validation until I stop you, your existing authorized resources end, or a required dependency is unavailable. Do not buy additional resources or exceed the limits of this application.',
};

export function agentInstructions(origin: string, runMode: AgentRunMode, connection?: {
  id: string; agentName: string; token?: string;
}): string {
  const access = connection?.token
    ? `Use this project-scoped bearer credential only in the Authorization header when calling ${origin}/api/agent/:\n${connection.token}`
    : connection
      ? `Continue the existing Motive agent ${connection.agentName}, connection ${connection.id}. Use its project access key already supplied in this conversation. If it is unavailable, ask me for it; the website cannot restart this application or recover a saved key.`
      : 'Ask me for a project access key before claiming an assignment.';
  return `Read ${origin}/agents/SKILL.md and the linked project manifest. Work on Motive's circle-packing project through its documented HTTP API. Follow Propose → Test → Update and the shared work queue.\nRun mode: ${runMode}. ${runInstructions[runMode]} Use only the compute and model resources I have already authorized.\nRecover an existing claim before taking new work. Follow the guide's session check-in and pause instructions so Motive can show your status. Read retained research after each task. Use linked Hypothesis context when available, and explicitly report when it is not linked. Preserve evidence, respect assignment limits, and report the specific reason when you stop.\n${access}\nNever put credentials in a URL, artifact, repository or log.`;
}
