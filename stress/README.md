# V4 stress and regression evidence

Read `../V4-REPAIR-VALIDATION.md` for the baseline comparison and measured results, and `../REPAIR-HANDOFF.md` for deployment and migration gates. This source is based on v4 commit 1b57d7a, not the earlier v3 repair.

Run `npm test`, `npm run test:stress`, `npm run test:http`, and (with CHROME set) `npm run test:browser`. Baseline capture scripts and baseline logs describe the original version and are not repaired-source acceptance tests. A real PostgreSQL server test remains required before rollout.
