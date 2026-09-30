-- Keep Allure matcher values outside raw_result so result details and agent
-- jobs can show the complete difference without scanning or retaining the
-- entire source document.
ALTER TABLE "test_results"
ADD COLUMN "assertion_actual" TEXT,
ADD COLUMN "assertion_expected" TEXT;

-- Existing failed results already retain the source Allure JSON. JSON `->>`
-- returns strings without quotes and serializes object-shaped values as JSON.
UPDATE "test_results"
SET
    "assertion_actual" = "raw_result" -> 'statusDetails' ->> 'actual',
    "assertion_expected" = "raw_result" -> 'statusDetails' ->> 'expected'
WHERE "raw_result" IS NOT NULL;
