import { validateTrustedComparatorProfile, validateTrustedComparatorReport,
  type ComparatorAssessment, type TrustedComparatorProfile, type ValidateTrustedComparatorReportInput } from './contract.ts';
import { RUNTIME_BOUND_PROFILE_FORMAT, validateRuntimeBoundComparatorProfile, type RuntimeBoundComparatorProfile } from './runtime-profile.ts';
import { validateRuntimeBoundComparatorReport, type RuntimeBoundComparatorAssessment } from './runtime-report.ts';

export type VersionedComparatorProfile = TrustedComparatorProfile | RuntimeBoundComparatorProfile;
export type VersionedComparatorAssessment = ComparatorAssessment | RuntimeBoundComparatorAssessment;
function usesRuntimeProfile(value: unknown): boolean {
  return typeof value === 'object' && value !== null && 'format' in value && value.format === RUNTIME_BOUND_PROFILE_FORMAT;
}
export function validateVersionedComparatorProfile(value: unknown): VersionedComparatorProfile {
  return usesRuntimeProfile(value) ? validateRuntimeBoundComparatorProfile(value) : validateTrustedComparatorProfile(value);
}
export function validateVersionedComparatorReport(input: ValidateTrustedComparatorReportInput): VersionedComparatorAssessment {
  return usesRuntimeProfile(input.evaluator_profile) ? validateRuntimeBoundComparatorReport(input) : validateTrustedComparatorReport(input);
}
