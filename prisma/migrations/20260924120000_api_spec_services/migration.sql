-- A project may contain several independently versioned APIs. Existing
-- snapshots use their OpenAPI title as the service identity.
ALTER TABLE "api_specs" ADD COLUMN "service_key" VARCHAR(200);

UPDATE "api_specs"
SET "service_key" = LEFT("title", 200);

ALTER TABLE "api_specs" ALTER COLUMN "service_key" SET NOT NULL;

DROP INDEX "api_specs_project_id_checksum_key";
DROP INDEX "api_specs_project_id_created_at_idx";

CREATE UNIQUE INDEX "api_specs_project_id_service_key_checksum_key"
ON "api_specs"("project_id", "service_key", "checksum");

CREATE INDEX "api_specs_project_id_service_key_created_at_idx"
ON "api_specs"("project_id", "service_key", "created_at");
