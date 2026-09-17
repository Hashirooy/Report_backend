-- OpenAPI snapshots per project, plus the flattened operation index that makes
-- comparing two versions a set operation instead of a tree walk.

CREATE TABLE "api_specs" (
    "id" BIGSERIAL NOT NULL,
    "project_id" BIGINT NOT NULL,
    "version" VARCHAR(200) NOT NULL,
    "title" VARCHAR(300) NOT NULL,
    "spec_version" VARCHAR(20) NOT NULL,
    "file_name" VARCHAR(300) NOT NULL,
    "checksum" VARCHAR(64) NOT NULL,
    "raw" TEXT NOT NULL,
    "size_bytes" INTEGER NOT NULL,
    "document" JSONB NOT NULL,
    "operation_count" INTEGER NOT NULL,
    "uploaded_by_user_id" BIGINT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "api_specs_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "api_operations" (
    "id" BIGSERIAL NOT NULL,
    "spec_id" BIGINT NOT NULL,
    "method" VARCHAR(10) NOT NULL,
    "path" VARCHAR(500) NOT NULL,
    "operation_id" VARCHAR(300),
    "summary" VARCHAR(1000),
    "tags" TEXT[],
    "status_codes" TEXT[],
    "deprecated" BOOLEAN NOT NULL DEFAULT false,
    "fingerprint" VARCHAR(64) NOT NULL,

    CONSTRAINT "api_operations_pkey" PRIMARY KEY ("id")
);

-- Re-uploading an unchanged document must resolve to the existing snapshot
-- rather than pile up duplicates.
CREATE UNIQUE INDEX "api_specs_project_id_checksum_key" ON "api_specs"("project_id", "checksum");
CREATE INDEX "api_specs_project_id_created_at_idx" ON "api_specs"("project_id", "created_at");

CREATE UNIQUE INDEX "api_operations_spec_id_method_path_key" ON "api_operations"("spec_id", "method", "path");
CREATE INDEX "api_operations_spec_id_idx" ON "api_operations"("spec_id");

ALTER TABLE "api_specs" ADD CONSTRAINT "api_specs_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "api_specs" ADD CONSTRAINT "api_specs_uploaded_by_user_id_fkey" FOREIGN KEY ("uploaded_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "api_operations" ADD CONSTRAINT "api_operations_spec_id_fkey" FOREIGN KEY ("spec_id") REFERENCES "api_specs"("id") ON DELETE CASCADE ON UPDATE CASCADE;
