# 04 — Locks module

**What to build:** The lock concept gets a deep module with a two-method seam: preserve (merge lock metadata onto metadata being rewritten) and require (verify the request's lock tokens authorize an operation on a resource path, including ancestor depth-infinity locks and shared-lock rules). No write handler knows the lock metadata key names or the legacy single-lock fallback anymore — those live only inside the module. The lock policy flag introduced by the tree-walk ticket delegates to this module, so the copy/move preservation divergence has exactly one home.

**Blocked by:** 03 — Tree-walk module

**Status:** ready-for-agent

- [ ] All write handlers (PUT, COPY, MOVE, PROPPATCH, LOCK, UNLOCK) interact with locks only through the module's two methods
- [ ] Lock metadata keys, legacy single-lock migration, and token normalization exist nowhere outside the module
- [ ] Unit tests cover: PUT after LOCK preserves the lock, MOVE preserves locks on both source and destination, COPY strips them
- [ ] Litmus locks suite stays green
