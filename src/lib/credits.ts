export const MOTIVE_CREDIT_UNIT = 'motive_credit' as const;
export const WELCOME_CREDIT_AMOUNT = 10;
export const CREDIT_ALLOCATION_STATUS = 'WAITING_FOR_FUNDED_RUN' as const;
export const CREDIT_PROJECTS = ['circle-packing'] as const;

export type CreditProject = typeof CREDIT_PROJECTS[number];

export type CreditAllocation = {
  id: string;
  project: CreditProject;
  amount: number;
  status: typeof CREDIT_ALLOCATION_STATUS;
  createdAt: string;
};

export type CreditWallet = {
  unit: typeof MOTIVE_CREDIT_UNIT;
  issued: number;
  available: number;
  allocated: number;
  allocations: CreditAllocation[];
  executionEnabled: false;
};

export type AllocateCreditsInput = {
  project: CreditProject;
  amount: number;
};

export type AllocateCreditsResponse = {
  wallet: CreditWallet;
  receipt: CreditAllocation;
};

export function parseAllocateCreditsInput(value: unknown): AllocateCreditsInput | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const input = value as Record<string, unknown>;
  if (Object.keys(input).sort().join(',') !== 'amount,project') return null;
  if (!CREDIT_PROJECTS.includes(input.project as CreditProject)) return null;
  if (!Number.isSafeInteger(input.amount) || (input.amount as number) <= 0) return null;
  return { project: input.project as CreditProject, amount: input.amount as number };
}
