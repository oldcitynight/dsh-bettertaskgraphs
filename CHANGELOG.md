# 0.3.1-rc.34 — DSH compatibility line

- Pin this build to its listed DSH releases and pair it with the other plugin on RC slot 4.
- Use the native Session plugin record API.

# 0.3.0-rc.11 — independent base and generic extension ports (2026-11-13)

- Restore the 0.2.3 standalone five-tool guidance and work protocol; restore the 16 MiB artifact default.
- Move joint revision prompts, reports and native role execution to the dynamic-context plugin. Retain generic structural revision validation.
- Add session-policy, CAS-store factory and durable graph-presence interfaces; no reverse dependency on dynamic context.
- Preserve committed V4 history; refuse to auto-commit legacy staged revisions without their original extension.

# 0.3.0-rc.10 — precise evidence navigation and scoped audit context (2026-11-12)

- Index source fields relative to parsed fact text. Invalid pointers report the missing segment and valid children; report-coverage failures identify missing, extra and duplicated change paths.
- Include fixed runtime semantics and only affected task states/dispositions in scoped audit input. Removing an unsatisfied dependency or invalid inheritance is distinguished from deleting historical records.
- Represent repeated large context nodes once in an exact content-addressed catalog. Before/after diffs and affected closures retain explicit references; source content, source checksums and the stored validated diff are preserved.
- Expose artifactCurrentIdentity separately from strict artifactProof so report-mode consumers can distinguish historical acceptance from current file observations, retaining path, symlink and change-during-read checks.

# 0.3.0-rc.9 — scoped modification reports (2026-11-12)

- Linked `report-scoped-v1` revision requires one explanation and verifiable original-source citation per effective change, including meaningful task-order changes.
- Expose `revision-report` for deterministic diffs, report/source validation and scoped audit assembly. Reject missing, extra or duplicate explanations and fabricated/unresolvable evidence before the audit.
- Audit receives the modification report, actual changed content, cited source fields and affected context closures. Existing graph/permission/history/commit validation remains in force; legacy standalone contexts keep their existing protocol.
