# 03 — Tree-walk module

**What to build:** One deep module owns recursive traversal of the resource tree: cursor pagination, prefix arithmetic, and the implicit-collection rule. The four copy-pasted listing loops in DELETE, COPY, and MOVE (root and collection cases) collapse into a single walk, and each handler keeps only its per-object operation. The copy/move/delete divergence in how lock metadata is handled (strip vs. preserve vs. ignore) becomes a policy flag on the walk rather than three drifted loops — a decision, not an accident of duplication.

**Blocked by:** 01 — Collection seam & dead-code cleanup, 02 — Local test seam

**Status:** ready-for-agent

- [ ] All recursive listing in DELETE/COPY/MOVE routes through the shared walk; no handler re-implements pagination or prefix arithmetic
- [ ] Per-object lock handling (strip / preserve / ignore) is expressed as one policy per operation; COPY and MOVE behave exactly as before
- [ ] Unit tests cover the walk against a fake cursor'd listing: root collection, nested collection, empty subtree
- [ ] Litmus compliance suite (basic, copymove) stays green
