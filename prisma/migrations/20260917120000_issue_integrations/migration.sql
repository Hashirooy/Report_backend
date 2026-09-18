-- Outbound integration: the one hand-composed HTTP request per project that
-- its finished bug reports are sent through, and the log of every send.

CREATE TYPE "IssueExportStatus" AS ENUM ('pending', 'succeeded', 'failed');

CREATE TABLE "project_integrations" (
    "id" BIGSERIAL NOT NULL,
    "project_id" BIGINT NOT NULL,
    "name" VARCHAR(200) NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "template" JSONB NOT NULL,
    "secret_encrypted" BYTEA,
    "secret_hint" VARCHAR(16),
    "created_by_user_id" BIGINT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "project_integrations_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "issue_exports" (
    "id" BIGSERIAL NOT NULL,
    "job_id" BIGINT NOT NULL,
    "artifact_id" BIGINT NOT NULL,
    "integration_id" BIGINT,
    "integration_name" VARCHAR(200) NOT NULL,
    "status" "IssueExportStatus" NOT NULL DEFAULT 'pending',
    "request_method" VARCHAR(10) NOT NULL,
    "request_url" TEXT NOT NULL,
    "response_status" INTEGER,
    "response_excerpt" TEXT,
    "external_key" VARCHAR(200),
    "external_url" TEXT,
    "error" TEXT,
    "created_by_user_id" BIGINT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finished_at" TIMESTAMPTZ(3),

    CONSTRAINT "issue_exports_pkey" PRIMARY KEY ("id")
);

-- One integration per project.
CREATE UNIQUE INDEX "project_integrations_project_id_key" ON "project_integrations"("project_id");
CREATE INDEX "issue_exports_job_id_created_at_idx" ON "issue_exports"("job_id", "created_at");
CREATE INDEX "issue_exports_integration_id_idx" ON "issue_exports"("integration_id");

ALTER TABLE "project_integrations" ADD CONSTRAINT "project_integrations_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "project_integrations" ADD CONSTRAINT "project_integrations_created_by_user_id_fkey" FOREIGN KEY ("created_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "issue_exports" ADD CONSTRAINT "issue_exports_job_id_fkey" FOREIGN KEY ("job_id") REFERENCES "reps_jobs"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "issue_exports" ADD CONSTRAINT "issue_exports_artifact_id_fkey" FOREIGN KEY ("artifact_id") REFERENCES "reps_artifacts"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "issue_exports" ADD CONSTRAINT "issue_exports_integration_id_fkey" FOREIGN KEY ("integration_id") REFERENCES "project_integrations"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "issue_exports" ADD CONSTRAINT "issue_exports_created_by_user_id_fkey" FOREIGN KEY ("created_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
