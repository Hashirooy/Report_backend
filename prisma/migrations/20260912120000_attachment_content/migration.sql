-- Attachments are ingested now, not just declared: textual bodies travel with
-- the row so serving one needs neither the archive nor object storage.
--
-- Existing rows: there are none, ingestion never wrote to this table.
ALTER TABLE "attachments" ADD COLUMN "content" TEXT;
ALTER TABLE "attachments" ADD COLUMN "truncated" BOOLEAN NOT NULL DEFAULT false;

-- Steps are the usual entry point into a result's attachments.
CREATE INDEX "attachments_step_id_idx" ON "attachments"("step_id");
