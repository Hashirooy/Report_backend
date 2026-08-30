-- Indexes and constraints Prisma's schema language cannot express.
-- Apply after `prisma migrate dev` with:
--   psql "$DATABASE_URL" -f prisma/sql/002_partial_indexes.sql

-- Run counters and result lists ignore superseded retry attempts, so the hot
-- path deserves a partial index rather than filtering a full one.
CREATE INDEX IF NOT EXISTS test_results_run_active_idx
  ON test_results (run_id, status)
  WHERE is_retry = false;

-- History screen: latest executions of one test case, newest first.
CREATE INDEX IF NOT EXISTS test_results_case_active_idx
  ON test_results (test_case_id, run_id DESC)
  WHERE is_retry = false;

-- Substring search over test names in the run results list.
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE INDEX IF NOT EXISTS test_cases_name_trgm_idx
  ON test_cases USING gin (name gin_trgm_ops);

-- Only one active (non-retry) result per test case per run.
CREATE UNIQUE INDEX IF NOT EXISTS test_results_one_active_per_case_idx
  ON test_results (run_id, test_case_id)
  WHERE is_retry = false;
