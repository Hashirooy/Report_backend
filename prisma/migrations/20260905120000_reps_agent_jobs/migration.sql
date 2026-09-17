-- CreateEnum
CREATE TYPE "RepsJobStatus" AS ENUM ('pending', 'running', 'waiting_for_user', 'succeeded', 'failed', 'cancelled');

-- CreateEnum
CREATE TYPE "RepsTaskStatus" AS ENUM ('pending', 'running', 'waiting_for_user', 'succeeded', 'failed', 'cancelled');

-- CreateEnum
CREATE TYPE "RepsTaskType" AS ENUM ('generate', 'validate');

-- CreateEnum
CREATE TYPE "RepsEventLevel" AS ENUM ('debug', 'info', 'warn', 'error');

-- NOTE: prisma migrate diff also proposed dropping "test_cases_name_trgm_idx".
-- That index is applied by hand from prisma/sql/002_partial_indexes.sql and is
-- invisible to the datamodel, so the drop was removed here on purpose.

-- CreateTable
CREATE TABLE "reps_jobs" (
    "id" BIGSERIAL NOT NULL,
    "project_id" BIGINT,
    "run_id" BIGINT,
    "kind" VARCHAR(64) NOT NULL,
    "user_request" TEXT NOT NULL,
    "status" "RepsJobStatus" NOT NULL DEFAULT 'pending',
    "workspace_dir" TEXT NOT NULL,
    "session_id" VARCHAR(64),
    "max_attempts_per_stage" INTEGER NOT NULL DEFAULT 3,
    "cancel_requested" BOOLEAN NOT NULL DEFAULT false,
    "error" TEXT,
    "summary" TEXT,
    "cost_usd" DECIMAL(10,6),
    "heartbeat_at" TIMESTAMPTZ(3),
    "started_at" TIMESTAMPTZ(3),
    "finished_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "reps_jobs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "reps_tasks" (
    "id" BIGSERIAL NOT NULL,
    "job_id" BIGINT NOT NULL,
    "type" "RepsTaskType" NOT NULL,
    "status" "RepsTaskStatus" NOT NULL DEFAULT 'pending',
    "order_num" INTEGER NOT NULL,
    "depends_on" BIGINT[],
    "attempt" INTEGER NOT NULL DEFAULT 1,
    "input" JSONB NOT NULL,
    "output" JSONB,
    "error" TEXT,
    "session_id" VARCHAR(64),
    "heartbeat_at" TIMESTAMPTZ(3),
    "started_at" TIMESTAMPTZ(3),
    "finished_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "reps_tasks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "reps_events" (
    "id" BIGSERIAL NOT NULL,
    "job_id" BIGINT NOT NULL,
    "task_id" BIGINT,
    "level" "RepsEventLevel" NOT NULL DEFAULT 'info',
    "message" TEXT NOT NULL,
    "data" JSONB,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "reps_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "reps_questions" (
    "id" BIGSERIAL NOT NULL,
    "job_id" BIGINT NOT NULL,
    "task_id" BIGINT,
    "external_id" VARCHAR(64) NOT NULL,
    "text" TEXT NOT NULL,
    "answer" TEXT,
    "asked_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "answered_at" TIMESTAMPTZ(3),

    CONSTRAINT "reps_questions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "reps_artifacts" (
    "id" BIGSERIAL NOT NULL,
    "job_id" BIGINT NOT NULL,
    "task_id" BIGINT NOT NULL,
    "path" TEXT NOT NULL,
    "media_type" VARCHAR(200) NOT NULL,
    "size_bytes" INTEGER NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "reps_artifacts_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "reps_jobs_status_created_at_idx" ON "reps_jobs"("status", "created_at");

-- CreateIndex
CREATE INDEX "reps_jobs_project_id_created_at_idx" ON "reps_jobs"("project_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "reps_tasks_job_id_order_num_idx" ON "reps_tasks"("job_id", "order_num");

-- CreateIndex
CREATE INDEX "reps_events_job_id_id_idx" ON "reps_events"("job_id", "id");

-- CreateIndex
CREATE INDEX "reps_questions_job_id_asked_at_idx" ON "reps_questions"("job_id", "asked_at");

-- CreateIndex
CREATE UNIQUE INDEX "reps_artifacts_job_id_path_key" ON "reps_artifacts"("job_id", "path");

-- AddForeignKey
ALTER TABLE "reps_jobs" ADD CONSTRAINT "reps_jobs_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reps_jobs" ADD CONSTRAINT "reps_jobs_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "test_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reps_tasks" ADD CONSTRAINT "reps_tasks_job_id_fkey" FOREIGN KEY ("job_id") REFERENCES "reps_jobs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reps_events" ADD CONSTRAINT "reps_events_job_id_fkey" FOREIGN KEY ("job_id") REFERENCES "reps_jobs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reps_events" ADD CONSTRAINT "reps_events_task_id_fkey" FOREIGN KEY ("task_id") REFERENCES "reps_tasks"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reps_questions" ADD CONSTRAINT "reps_questions_job_id_fkey" FOREIGN KEY ("job_id") REFERENCES "reps_jobs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reps_questions" ADD CONSTRAINT "reps_questions_task_id_fkey" FOREIGN KEY ("task_id") REFERENCES "reps_tasks"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reps_artifacts" ADD CONSTRAINT "reps_artifacts_job_id_fkey" FOREIGN KEY ("job_id") REFERENCES "reps_jobs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reps_artifacts" ADD CONSTRAINT "reps_artifacts_task_id_fkey" FOREIGN KEY ("task_id") REFERENCES "reps_tasks"("id") ON DELETE CASCADE ON UPDATE CASCADE;

