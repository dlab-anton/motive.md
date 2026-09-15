import { DEFAULT_PROJECT_SLUG, skillPath } from './project-slug';
export type AgentRunMode = 'ONE_TASK' | 'THIRTY_MINUTES' | 'UNTIL_STOPPED';
export type AgentTransport = 'http' | 'mcp';

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
}, transport: AgentTransport = 'http', slug = DEFAULT_PROJECT_SLUG): string {
  if (transport === 'mcp') {
    const canonicalOrigin = origin.replace(/\/+$/, '');
    const identity = connection
      ? `Continue the existing Motive agent ${connection.agentName}, connection ${connection.id}. After get_work_queue, call get_assignment once before any write to verify the configured agent. Verify its credential projection has id ${connection.id} and agentName ${connection.agentName}; if either differs, stop and ask me to update the project access key in the extension settings. After verification, use get_assignment only to refresh actual assignment or lease state.`
      : 'After get_work_queue, use get_assignment only when you need to refresh actual assignment or lease state. Use its credential projection as the configured connection identity.';
    return `Use the installed Motive extension for every Motive call. Do not call Motive through HTTP, fetch, curl, browser navigation or another connector. The canonical project is ${canonicalOrigin}/?project=${slug} and its canonical guide is ${canonicalOrigin}${skillPath(slug)}. First use read_project_document through the extension to read ${skillPath(slug).slice(1)} and its linked ${slug === DEFAULT_PROJECT_SLUG ? 'agents/circle-packing.json' : `agents/${slug}/${slug}.json`} manifest. Follow Propose → Test → Update and the shared work queue.\nRun mode: ${runMode}. ${runInstructions[runMode]} Use only the compute and model resources I have already authorized.\nCall get_work_queue first; it is authoritative for available work and recovery of an existing claim. Recover existing work before taking a new claim. Follow the guide's session check-in and pause instructions with set_session_status so Motive can show your status. Read retained and shared research after each task with the extension, use linked Hypothesis context when available, and explicitly report when it is not linked. Preserve evidence, append the required post-check, perform any eligible finding review and research sync through the extension, respect assignment limits, and report the specific reason when you stop.\n${identity}\nThe project access key is held in the extension's sensitive settings. Never ask me to paste or repeat it in chat, and never put credentials in a URL, artifact, repository, log or message.`;
  }
  const access = connection?.token
    ? `Use this project-scoped bearer credential only in the Authorization header when calling ${origin}/api/agent/:\n${connection.token}`
    : connection
      ? `Continue the existing Motive agent ${connection.agentName}, connection ${connection.id}. Use its project access key already supplied in this conversation. If it is unavailable, ask me for it; the website cannot restart this application or recover a saved key.`
      : 'Ask me for a project access key before claiming an assignment.';
  return `Read ${origin}${skillPath(slug)} and the linked project manifest. Work on Motive's ${slug} project through its documented HTTP API. Follow Propose → Test → Update and the shared work queue.\nRun mode: ${runMode}. ${runInstructions[runMode]} Use only the compute and model resources I have already authorized.\nRecover an existing claim before taking new work. Follow the guide's session check-in and pause instructions so Motive can show your status. Read retained research after each task. Use linked Hypothesis context when available, and explicitly report when it is not linked. Preserve evidence, respect assignment limits, and report the specific reason when you stop.\n${access}\nNever put credentials in a URL, artifact, repository or log.`;
}
