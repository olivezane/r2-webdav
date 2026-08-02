# 05 — Content-serving module

**What to build:** GET and HEAD route through one module that maps a request plus an object into an HTTP response. R2's three range shapes (offset+length, length-only, suffix) translate to HTTP status, Content-Range, and Content-Length entirely inside the module — conditional headers (only-if), the 200-vs-206 decision, and HEAD as status-and-headers-only all live there too. The historical range bugs get a defined answer: an oversized suffix range is either clamped or answered per HTTP semantics instead of producing an invalid negative offset, with regression tests for each of the three past fixes.

**Blocked by:** 01 — Collection seam & dead-code cleanup, 02 — Local test seam

**Status:** ready-for-agent

- [ ] GET and HEAD call the module; no handler re-encodes range shapes into header math
- [ ] Oversized suffix range has a defined, correct response (clamp or unsatisfiable), covered by a unit test
- [ ] Regression tests exist for each of the three historical range/status fixes (200-vs-206 for non-Range GET, suffix-value handling, byte-range math)
- [ ] Litmus compliance suite stays green
