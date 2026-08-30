// Parses every fixture through its schema so mocks cannot drift from contracts.
import {
  ProjectDashboardSchema,
  ResultDetailSchema,
  ResultListItemSchema,
  RunListItemSchema,
  TestCaseHistorySchema,
} from '../dist/contracts/index.js';
import * as mocks from '../dist/contracts/mocks.js';

const checks = [
  ['mockDashboard', ProjectDashboardSchema, mocks.mockDashboard],
  ['mockRuns', RunListItemSchema.array(), mocks.mockRuns],
  ['mockResults', ResultListItemSchema.array(), mocks.mockResults],
  ['mockResultDetail', ResultDetailSchema, mocks.mockResultDetail],
  ['mockHistory', TestCaseHistorySchema, mocks.mockHistory],
];

let failed = 0;
for (const [name, schema, value] of checks) {
  const parsed = schema.safeParse(value);
  if (parsed.success) {
    console.log(`  ok   ${name}`);
  } else {
    failed++;
    console.error(`  FAIL ${name}`);
    for (const issue of parsed.error.issues) {
      console.error(`       ${issue.path.join('.')}: ${issue.message}`);
    }
  }
}
process.exit(failed ? 1 : 0);
