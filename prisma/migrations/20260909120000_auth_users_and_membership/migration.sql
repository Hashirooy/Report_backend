-- Authentication and per-project access.
--
-- Until now every read endpoint was open and the only credential was one shared
-- ingest token. This adds people (users), what they may see (project_members)
-- and machine credentials scoped to a single project (project_tokens).
--
-- Nothing here backfills access: after this migration the projects table has no
-- members at all, so only global admins can read anything. Create the first
-- admin with `npm run create:admin`, then grant membership from the API.

CREATE TYPE "UserRole" AS ENUM ('admin', 'member');
CREATE TYPE "ProjectMemberRole" AS ENUM ('viewer', 'maintainer');

CREATE TABLE "users" (
  "id" BIGSERIAL NOT NULL,
  "email" VARCHAR(320) NOT NULL,
  "password_hash" TEXT NOT NULL,
  "name" VARCHAR(200) NOT NULL,
  "role" "UserRole" NOT NULL DEFAULT 'member',
  "is_active" BOOLEAN NOT NULL DEFAULT true,
  -- Sessions are stateless, so this is the only way to invalidate tokens that
  -- were handed out before a password change or a forced reset.
  "password_changed_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "last_login_at" TIMESTAMPTZ(3),
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(3) NOT NULL,

  CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- Email is stored lower-cased by the application, so this index is the login
-- lookup and the duplicate check at once.
CREATE UNIQUE INDEX "users_email_key" ON "users" ("email");

CREATE TABLE "project_members" (
  "id" BIGSERIAL NOT NULL,
  "project_id" BIGINT NOT NULL,
  "user_id" BIGINT NOT NULL,
  "role" "ProjectMemberRole" NOT NULL DEFAULT 'viewer',
  "added_by_user_id" BIGINT,
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "project_members_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "project_members_project_id_user_id_key"
  ON "project_members" ("project_id", "user_id");
-- Serves "which projects may this user see", asked on every project listing.
CREATE INDEX "project_members_user_id_idx" ON "project_members" ("user_id");

CREATE TABLE "project_tokens" (
  "id" BIGSERIAL NOT NULL,
  "project_id" BIGINT NOT NULL,
  "name" VARCHAR(200) NOT NULL,
  -- SHA-256 hex of the secret. The secret itself is shown once and never kept:
  -- a token is a bearer credential, so the database must not be able to leak it.
  "token_hash" CHAR(64) NOT NULL,
  "prefix" VARCHAR(12) NOT NULL,
  "created_by_user_id" BIGINT,
  "last_used_at" TIMESTAMPTZ(3),
  "revoked_at" TIMESTAMPTZ(3),
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "project_tokens_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "project_tokens_token_hash_key" ON "project_tokens" ("token_hash");
CREATE INDEX "project_tokens_project_id_idx" ON "project_tokens" ("project_id");

-- Audit columns on what people create. Nullable: existing rows have no author,
-- and an ingest upload creates projects with no user behind the request.
ALTER TABLE "projects" ADD COLUMN "created_by_user_id" BIGINT;
ALTER TABLE "reps_jobs" ADD COLUMN "created_by_user_id" BIGINT;

-- A job anchored to nothing is visible only to its author, so the list query
-- filters on this column.
CREATE INDEX "reps_jobs_created_by_user_id_created_at_idx"
  ON "reps_jobs" ("created_by_user_id", "created_at" DESC);

ALTER TABLE "project_members"
  ADD CONSTRAINT "project_members_project_id_fkey"
  FOREIGN KEY ("project_id") REFERENCES "projects"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "project_members"
  ADD CONSTRAINT "project_members_user_id_fkey"
  FOREIGN KEY ("user_id") REFERENCES "users"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

-- The grant outlives whoever made it.
ALTER TABLE "project_members"
  ADD CONSTRAINT "project_members_added_by_user_id_fkey"
  FOREIGN KEY ("added_by_user_id") REFERENCES "users"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "project_tokens"
  ADD CONSTRAINT "project_tokens_project_id_fkey"
  FOREIGN KEY ("project_id") REFERENCES "projects"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "project_tokens"
  ADD CONSTRAINT "project_tokens_created_by_user_id_fkey"
  FOREIGN KEY ("created_by_user_id") REFERENCES "users"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "projects"
  ADD CONSTRAINT "projects_created_by_user_id_fkey"
  FOREIGN KEY ("created_by_user_id") REFERENCES "users"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "reps_jobs"
  ADD CONSTRAINT "reps_jobs_created_by_user_id_fkey"
  FOREIGN KEY ("created_by_user_id") REFERENCES "users"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;
