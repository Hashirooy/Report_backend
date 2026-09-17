-- A job may now be about a single test execution rather than a whole run.
-- The anchor is a result row, not a test case: "why did this fail here" needs
-- the trace of one execution, and the case's history is derived from it.
--
-- Nullable and unset for existing rows: they were all run- or project-scoped.
ALTER TABLE "reps_jobs" ADD COLUMN "result_id" BIGINT;

ALTER TABLE "reps_jobs"
  ADD CONSTRAINT "reps_jobs_result_id_fkey"
  FOREIGN KEY ("result_id") REFERENCES "test_results"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

-- Serves "show me the jobs raised on this failure", newest first.
CREATE INDEX "reps_jobs_result_id_created_at_idx"
  ON "reps_jobs" ("result_id", "created_at" DESC);
