-- Artifacts carry their text, so serving one no longer needs the worker's disk.
--
-- Written by hand rather than by `migrate diff`: the column is NOT NULL and the
-- table already has rows, so it is added with a default and the default is then
-- dropped. Rows created before this migration keep an empty body — their file
-- may still be in the workspace, but nothing reads from there any more.
ALTER TABLE "reps_artifacts" ADD COLUMN "content" TEXT NOT NULL DEFAULT '';
ALTER TABLE "reps_artifacts" ALTER COLUMN "content" DROP DEFAULT;
