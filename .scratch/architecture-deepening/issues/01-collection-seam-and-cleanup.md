# 01 — Collection seam & dead-code cleanup

**What to build:** "Is this resource a collection?" becomes one named predicate instead of fifteen copies of a string-literal comparison against the collection marker. A dead XML-tag-name validator is removed, and the source file's mixed snake_case/camelCase naming is unified to camelCase. This is the prefactor everything else lands on: the marker's meaning is documented at its single definition, and the predicate becomes the hook the tree-walk and content-serving modules hang off.

**Blocked by:** None — can start immediately

**Status:** ready-for-agent

- [ ] One predicate (e.g. `isCollection`) is the only place the collection marker is read; all 15 call sites route through it
- [ ] The unused XML-tag-name validator is deleted
- [ ] All identifiers use one naming convention (camelCase); no behavior change
- [ ] Local WebDAV compliance suite (litmus) stays green
