/**
 * Single source of truth for URLs, shared by the Nest controllers and the web
 * client. `projectId` accepts a slug or a numeric id; `runId` accepts a run
 * number or a numeric id.
 */
export const API_PREFIX = '/api';

const qs = (params?: Record<string, string | number | boolean | undefined>) => {
  if (!params) return '';
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) search.set(key, String(value));
  }
  const s = search.toString();
  return s ? `?${s}` : '';
};

type Query = Record<string, string | number | boolean | undefined>;

export const routes = {
  /** Session lives in an httpOnly cookie, so these take no token argument. */
  login: () => `${API_PREFIX}/auth/login`,
  logout: () => `${API_PREFIX}/auth/logout`,
  me: () => `${API_PREFIX}/auth/me`,
  changePassword: () => `${API_PREFIX}/auth/password`,

  /** User administration. Admin only. */
  users: () => `${API_PREFIX}/users`,
  user: (userId: string) => `${API_PREFIX}/users/${userId}`,

  projectMembers: (projectId: string) => `${API_PREFIX}/projects/${projectId}/members`,
  projectMember: (projectId: string, userId: string) =>
    `${API_PREFIX}/projects/${projectId}/members/${userId}`,
  projectTokens: (projectId: string) => `${API_PREFIX}/projects/${projectId}/tokens`,
  projectToken: (projectId: string, tokenId: string) =>
    `${API_PREFIX}/projects/${projectId}/tokens/${tokenId}`,

  projects: (q?: Query) => `${API_PREFIX}/projects${qs(q)}`,
  project: (projectId: string) => `${API_PREFIX}/projects/${projectId}`,
  projectSummary: (projectId: string, q?: Query) =>
    `${API_PREFIX}/projects/${projectId}/summary${qs(q)}`,
  projectDashboard: (projectId: string, q?: Query) =>
    `${API_PREFIX}/projects/${projectId}/dashboard${qs(q)}`,
  runs: (projectId: string, q?: Query) => `${API_PREFIX}/projects/${projectId}/runs${qs(q)}`,
  run: (projectId: string, runId: string) =>
    `${API_PREFIX}/projects/${projectId}/runs/${runId}`,
  runResults: (projectId: string, runId: string, q?: Query) =>
    `${API_PREFIX}/projects/${projectId}/runs/${runId}/results${qs(q)}`,
  result: (projectId: string, runId: string, resultId: string) =>
    `${API_PREFIX}/projects/${projectId}/runs/${runId}/results/${resultId}`,
  runErrorGroups: (projectId: string, runId: string, q?: Query) =>
    `${API_PREFIX}/projects/${projectId}/runs/${runId}/errors${qs(q)}`,
  testCaseHistory: (projectId: string, testCaseId: string, q?: Query) =>
    `${API_PREFIX}/projects/${projectId}/test-cases/${testCaseId}/history${qs(q)}`,
  projectErrors: (projectId: string, q?: Query) =>
    `${API_PREFIX}/projects/${projectId}/errors${qs(q)}`,
  projectFlaky: (projectId: string, q?: Query) =>
    `${API_PREFIX}/projects/${projectId}/flaky${qs(q)}`,
  ingest: () => `${API_PREFIX}/ingest`,

  /** OpenAPI snapshots. `specId` is always the numeric id. */
  apiSpecs: (projectId: string, q?: Query) =>
    `${API_PREFIX}/projects/${projectId}/api-specs${qs(q)}`,
  apiSpec: (projectId: string, specId: string) =>
    `${API_PREFIX}/projects/${projectId}/api-specs/${specId}`,
  apiSpecRaw: (projectId: string, specId: string) =>
    `${API_PREFIX}/projects/${projectId}/api-specs/${specId}/raw`,
  /** `against` takes a snapshot id; omitted it means the preceding snapshot. */
  apiSpecDiff: (projectId: string, specId: string, q?: Query) =>
    `${API_PREFIX}/projects/${projectId}/api-specs/${specId}/diff${qs(q)}`,

  /** Reps agent jobs. `jobId` is always the numeric id — jobs have no number. */
  repsJobs: (q?: Query) => `${API_PREFIX}/reps/jobs${qs(q)}`,
  repsJob: (jobId: string) => `${API_PREFIX}/reps/jobs/${jobId}`,
  repsJobEvents: (jobId: string, q?: Query) =>
    `${API_PREFIX}/reps/jobs/${jobId}/events${qs(q)}`,
  repsJobResume: (jobId: string) => `${API_PREFIX}/reps/jobs/${jobId}/resume`,
  repsJobTerminate: (jobId: string) => `${API_PREFIX}/reps/jobs/${jobId}/terminate`,
  repsArtifact: (jobId: string, artifactId: string) =>
    `${API_PREFIX}/reps/jobs/${jobId}/artifacts/${artifactId}`,
} as const;

/** TanStack Query keys, so cache seeding from /dashboard stays type-safe. */
export const queryKeys = {
  me: () => ['auth', 'me'] as const,
  users: () => ['users'] as const,
  projectMembers: (projectId: string) => ['projects', projectId, 'members'] as const,
  projectTokens: (projectId: string) => ['projects', projectId, 'tokens'] as const,
  projects: () => ['projects'] as const,
  project: (projectId: string) => ['projects', projectId] as const,
  dashboard: (projectId: string) => ['projects', projectId, 'dashboard'] as const,
  runs: (projectId: string, q: Query) => ['projects', projectId, 'runs', q] as const,
  run: (projectId: string, runId: string) =>
    ['projects', projectId, 'runs', runId] as const,
  results: (projectId: string, runId: string, q: Query) =>
    ['projects', projectId, 'runs', runId, 'results', q] as const,
  result: (projectId: string, runId: string, resultId: string) =>
    ['projects', projectId, 'runs', runId, 'results', resultId] as const,
  history: (projectId: string, testCaseId: string) =>
    ['projects', projectId, 'test-cases', testCaseId, 'history'] as const,
  repsJobs: (q: Query) => ['reps', 'jobs', q] as const,
  repsJob: (jobId: string) => ['reps', 'jobs', jobId] as const,
  repsJobEvents: (jobId: string) => ['reps', 'jobs', jobId, 'events'] as const,
  apiSpecs: (projectId: string) => ['projects', projectId, 'api-specs'] as const,
  apiSpec: (projectId: string, specId: string) =>
    ['projects', projectId, 'api-specs', specId] as const,
  apiSpecDiff: (projectId: string, specId: string, against?: string) =>
    ['projects', projectId, 'api-specs', specId, 'diff', against ?? 'previous'] as const,
} as const;
