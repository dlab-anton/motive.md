export type SandboxAdapterErrorCode =
  | 'SANDBOX_POLICY_INVALID'
  | 'SANDBOX_EFFECTS_SUSPENDED'
  | 'SANDBOX_HANDLE_INVALID'
  | 'SANDBOX_PROVIDER_CONTRACT'
  | 'SANDBOX_CREATE_EFFECT_UNKNOWN'
  | 'SANDBOX_COMMAND_EFFECT_UNKNOWN'
  | 'SANDBOX_STOP_EFFECT_UNKNOWN'
  | 'SANDBOX_OBSERVATION_FAILED'
  | 'SANDBOX_NOT_RUNNING'
  | 'SANDBOX_ARTIFACT_PATH_INVALID';

export class SandboxAdapterError extends Error {
  constructor(
    readonly code: SandboxAdapterErrorCode,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = 'SandboxAdapterError';
  }
}

export class SandboxCreateEffectUnknownError extends SandboxAdapterError {
  constructor(readonly sandboxName: string, cause: unknown) {
    super(
      'SANDBOX_CREATE_EFFECT_UNKNOWN',
      `Sandbox creation for ${sandboxName} has an unknown effect; reconcile the recorded intent by exact name before another create.`,
      { cause },
    );
    this.name = 'SandboxCreateEffectUnknownError';
  }
}

export class SandboxCommandEffectUnknownError extends SandboxAdapterError {
  constructor(readonly sandboxName: string, readonly operationId: string, cause: unknown) {
    super(
      'SANDBOX_COMMAND_EFFECT_UNKNOWN',
      `Command ${operationId} in ${sandboxName} has an unknown effect; inspect a persisted command handle before another launch.`,
      { cause },
    );
    this.name = 'SandboxCommandEffectUnknownError';
  }
}

export class SandboxStopEffectUnknownError extends SandboxAdapterError {
  constructor(readonly sandboxName: string, cause: unknown) {
    super(
      'SANDBOX_STOP_EFFECT_UNKNOWN',
      `Stop for ${sandboxName} has an unknown effect; observe the exact sandbox before issuing another stop.`,
      { cause },
    );
    this.name = 'SandboxStopEffectUnknownError';
  }
}
