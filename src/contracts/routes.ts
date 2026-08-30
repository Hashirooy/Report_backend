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
} as const;

/** TanStack Query keys, so cache seeding from /dashboard stays type-safe. */
export const queryKeys = {
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
} as const;
