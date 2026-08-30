-- CreateEnum
CREATE TYPE "TestStatus" AS ENUM ('failed', 'broken', 'unknown', 'skipped', 'passed');

-- CreateEnum
CREATE TYPE "RunStatus" AS ENUM ('passed', 'failed');

-- CreateEnum
CREATE TYPE "IngestStatus" AS ENUM ('pending', 'parsing', 'ready', 'parse_failed');

-- CreateEnum
CREATE TYPE "StepKind" AS ENUM ('step', 'before', 'after');

-- CreateTable
CREATE TABLE "projects" (
    "id" BIGSERIAL NOT NULL,
    "slug" VARCHAR(64) NOT NULL,
    "name" VARCHAR(200) NOT NULL,
    "description" TEXT,
    "repository_url" TEXT,
    "default_branch" VARCHAR(200) NOT NULL DEFAULT 'main',
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "projects_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "test_runs" (
    "id" BIGSERIAL NOT NULL,
    "project_id" BIGINT NOT NULL,
    "run_number" INTEGER NOT NULL,
    "branch" VARCHAR(200) NOT NULL,
    "commit_sha" VARCHAR(64),
    "environment" VARCHAR(64),
    "ci_build_id" VARCHAR(64),
    "ci_build_url" TEXT,
    "status" "RunStatus",
    "ingest_status" "IngestStatus" NOT NULL DEFAULT 'pending',
    "ingest_error" TEXT,
    "started_at" TIMESTAMPTZ(3),
    "finished_at" TIMESTAMPTZ(3),
    "duration_ms" INTEGER,
    "total" INTEGER NOT NULL DEFAULT 0,
    "passed" INTEGER NOT NULL DEFAULT 0,
    "failed" INTEGER NOT NULL DEFAULT 0,
    "broken" INTEGER NOT NULL DEFAULT 0,
    "skipped" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "test_runs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "test_cases" (
    "id" BIGSERIAL NOT NULL,
    "project_id" BIGINT NOT NULL,
    "history_id" VARCHAR(128) NOT NULL,
    "full_name" TEXT,
    "name" TEXT NOT NULL,
    "suite" VARCHAR(500),
    "last_seen_labels" JSONB,
    "last_seen_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "test_cases_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "test_results" (
    "id" BIGSERIAL NOT NULL,
    "project_id" BIGINT NOT NULL,
    "run_id" BIGINT NOT NULL,
    "test_case_id" BIGINT NOT NULL,
    "uuid" UUID NOT NULL,
    "status" "TestStatus" NOT NULL,
    "description" TEXT,
    "status_message" TEXT,
    "status_trace" TEXT,
    "error_group_id" BIGINT,
    "start_ms" BIGINT,
    "stop_ms" BIGINT,
    "duration_ms" INTEGER,
    "is_retry" BOOLEAN NOT NULL DEFAULT false,
    "attempt" INTEGER NOT NULL DEFAULT 1,
    "labels" JSONB,
    "parameters" JSONB,
    "links" JSONB,
    "raw_result" JSONB,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "test_results_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "test_steps" (
    "id" BIGSERIAL NOT NULL,
    "result_id" BIGINT NOT NULL,
    "parent_step_id" BIGINT,
    "kind" "StepKind" NOT NULL DEFAULT 'step',
    "order_num" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "status" "TestStatus" NOT NULL,
    "duration_ms" INTEGER,
    "message" TEXT,
    "trace" TEXT,
    "parameters" JSONB,
    "attachments_count" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "test_steps_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "error_groups" (
    "id" BIGSERIAL NOT NULL,
    "project_id" BIGINT NOT NULL,
    "fingerprint" CHAR(64) NOT NULL,
    "error_type" VARCHAR(200),
    "normalized_message" TEXT NOT NULL,
    "sample_message" TEXT NOT NULL,
    "sample_trace" TEXT,
    "first_seen_at" TIMESTAMPTZ(3) NOT NULL,
    "last_seen_at" TIMESTAMPTZ(3) NOT NULL,
    "occurrences" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "error_groups_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "attachments" (
    "id" BIGSERIAL NOT NULL,
    "project_id" BIGINT NOT NULL,
    "run_id" BIGINT NOT NULL,
    "result_id" BIGINT NOT NULL,
    "step_id" BIGINT,
    "name" TEXT NOT NULL,
    "type" VARCHAR(200),
    "bucket" VARCHAR(200),
    "storage_key" TEXT,
    "size_bytes" INTEGER,

    CONSTRAINT "attachments_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "projects_slug_key" ON "projects"("slug");

-- CreateIndex
CREATE INDEX "test_runs_project_id_run_number_idx" ON "test_runs"("project_id", "run_number" DESC);

-- CreateIndex
CREATE INDEX "test_runs_project_id_finished_at_idx" ON "test_runs"("project_id", "finished_at" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "test_runs_project_id_run_number_key" ON "test_runs"("project_id", "run_number");

-- CreateIndex
CREATE UNIQUE INDEX "test_runs_project_id_ci_build_id_key" ON "test_runs"("project_id", "ci_build_id");

-- CreateIndex
CREATE INDEX "test_cases_project_id_suite_idx" ON "test_cases"("project_id", "suite");

-- CreateIndex
CREATE UNIQUE INDEX "test_cases_project_id_history_id_key" ON "test_cases"("project_id", "history_id");

-- CreateIndex
CREATE INDEX "test_results_run_id_status_idx" ON "test_results"("run_id", "status");

-- CreateIndex
CREATE INDEX "test_results_test_case_id_run_id_idx" ON "test_results"("test_case_id", "run_id" DESC);

-- CreateIndex
CREATE INDEX "test_results_error_group_id_idx" ON "test_results"("error_group_id");

-- CreateIndex
CREATE INDEX "test_results_project_id_created_at_idx" ON "test_results"("project_id", "created_at" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "test_results_run_id_uuid_key" ON "test_results"("run_id", "uuid");

-- CreateIndex
CREATE INDEX "test_steps_result_id_parent_step_id_order_num_idx" ON "test_steps"("result_id", "parent_step_id", "order_num");

-- CreateIndex
CREATE INDEX "error_groups_project_id_last_seen_at_idx" ON "error_groups"("project_id", "last_seen_at" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "error_groups_project_id_fingerprint_key" ON "error_groups"("project_id", "fingerprint");

-- CreateIndex
CREATE INDEX "attachments_result_id_idx" ON "attachments"("result_id");

-- AddForeignKey
ALTER TABLE "test_runs" ADD CONSTRAINT "test_runs_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "test_cases" ADD CONSTRAINT "test_cases_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "test_results" ADD CONSTRAINT "test_results_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "test_results" ADD CONSTRAINT "test_results_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "test_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "test_results" ADD CONSTRAINT "test_results_test_case_id_fkey" FOREIGN KEY ("test_case_id") REFERENCES "test_cases"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "test_results" ADD CONSTRAINT "test_results_error_group_id_fkey" FOREIGN KEY ("error_group_id") REFERENCES "error_groups"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "test_steps" ADD CONSTRAINT "test_steps_result_id_fkey" FOREIGN KEY ("result_id") REFERENCES "test_results"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "test_steps" ADD CONSTRAINT "test_steps_parent_step_id_fkey" FOREIGN KEY ("parent_step_id") REFERENCES "test_steps"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "error_groups" ADD CONSTRAINT "error_groups_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "attachments" ADD CONSTRAINT "attachments_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "attachments" ADD CONSTRAINT "attachments_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "test_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "attachments" ADD CONSTRAINT "attachments_result_id_fkey" FOREIGN KEY ("result_id") REFERENCES "test_results"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "attachments" ADD CONSTRAINT "attachments_step_id_fkey" FOREIGN KEY ("step_id") REFERENCES "test_steps"("id") ON DELETE CASCADE ON UPDATE CASCADE;
