-- The agent no longer has a filesystem: it returns documents in its structured
-- answer, so there is no scratch directory to record and an artifact is named
-- rather than located.
--
-- Existing rows carry a path like "output/report.md"; it is kept as-is rather
-- than rewritten, since it is only ever shown as a download name.
ALTER TABLE "reps_jobs" DROP COLUMN "workspace_dir";

ALTER TABLE "reps_artifacts" RENAME COLUMN "path" TO "name";
ALTER TABLE "reps_artifacts" ALTER COLUMN "name" TYPE VARCHAR(200);
ALTER INDEX "reps_artifacts_job_id_path_key" RENAME TO "reps_artifacts_job_id_name_key";
