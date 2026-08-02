# 02 — Local test seam

**What to build:** The repo's first unit-test harness. `npm test` runs pure-function smoke tests locally and in CI alongside the existing compliance suite — covering XML escaping, lock-token normalization, and timeout parsing. This establishes the runner and the pure-function testing style that the later refactor tickets (03–05) use for their regression tests; it is deliberately small, not a framework migration.

**Blocked by:** None — can start immediately

**Status:** ready-for-agent

- [ ] `npm test` runs a small set of pure-function tests; green in CI on the existing Node version
- [ ] Smoke tests exist for XML escaping, lock-token normalization, and lock-timeout parsing edge cases
- [ ] Existing compliance workflow (litmus) still runs and passes
- [ ] No new test framework dependency beyond what the runtime/CI already provides
