export const geometryComparisonFormat = 'motive.csqv.geometry-comparison.v1' as const;
export const geometryComparisonUuidPattern = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
export const geometryComparisonDigestPattern = /^sha256:[a-f0-9]{64}$/;

export type GeometryComparisonReference = { submissionId: string; artifactSha256: string };
export type GeometryComparisonRelation = 'SAME_GEOMETRY' | 'SQUARE_SYMMETRY' | 'DIFFERENT_GEOMETRY';
export type GeometryComparisonResponse = {
  format: typeof geometryComparisonFormat;
  left: GeometryComparisonReference;
  right: GeometryComparisonReference;
  relation: GeometryComparisonRelation;
};

const readError = () => new Error('No geometry comparison is available. Please try again.');
function record(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
function exact(value: Record<string, unknown>, keys: readonly string[]) {
  return Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
}
function validReference(value: unknown, expected: GeometryComparisonReference): value is GeometryComparisonReference {
  return record(value) && exact(value, ['submissionId', 'artifactSha256'])
    && value.submissionId === expected.submissionId && value.artifactSha256 === expected.artifactSha256;
}
function validInput(value: GeometryComparisonReference) {
  return geometryComparisonUuidPattern.test(value.submissionId)
    && geometryComparisonDigestPattern.test(value.artifactSha256);
}

export function parseGeometryComparison(value: unknown, left: GeometryComparisonReference,
  right: GeometryComparisonReference): GeometryComparisonResponse {
  try {
    if (!record(value) || !exact(value, ['format', 'left', 'right', 'relation'])
      || value.format !== geometryComparisonFormat
      || !validReference(value.left, left) || !validReference(value.right, right)
      || !['SAME_GEOMETRY', 'SQUARE_SYMMETRY', 'DIFFERENT_GEOMETRY'].includes(String(value.relation))) throw readError();
    return value as GeometryComparisonResponse;
  } catch {
    throw readError();
  }
}

export async function readGeometryComparison(left: GeometryComparisonReference, right: GeometryComparisonReference,
  signal: AbortSignal): Promise<GeometryComparisonResponse> {
  if (!validInput(left) || !validInput(right)) throw readError();
  const path = `/api/public/projects/circle-packing/submissions/${left.submissionId}/geometry-comparison?against=${encodeURIComponent(right.submissionId)}`;
  let response: Response;
  try {
    response = await fetch(path, { method: 'GET', credentials: 'omit', cache: 'no-store', redirect: 'error',
      headers: { Accept: 'application/json' }, signal: AbortSignal.any([signal, AbortSignal.timeout(20_000)]) });
  } catch (error) {
    if (signal.aborted) throw error;
    throw readError();
  }
  if (!response.ok) throw readError();
  let body: unknown;
  try { body = await response.json(); }
  catch { throw readError(); }
  return parseGeometryComparison(body, left, right);
}
