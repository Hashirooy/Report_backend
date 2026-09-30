-- Disabled snapshots remain available for inspection and diffs, but contract
-- resolution considers only active snapshots.
ALTER TABLE "api_specs"
ADD COLUMN "active" BOOLEAN NOT NULL DEFAULT true;

DROP INDEX "api_specs_project_id_service_key_created_at_idx";

CREATE INDEX "api_specs_project_id_service_key_active_created_at_idx"
ON "api_specs"("project_id", "service_key", "active", "created_at");
