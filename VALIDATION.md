# Candidate validation: 0.3.0-rc.11

Validated on 2026-11-13 with Node.js 24.22.2 and DSH 0.2.1-rc.5.

- 103 task-graph tests passed with dynamic-context imports forbidden.
- A real DSH service mounted independently, exposing the original five tools and guidance.
- Tool definitions and work policy match the 0.2.3 baseline except for the file header; initial guidance is byte-identical.
- Client source/build parity passed.
- The packaged service mounted after an isolated offline installation.
- The companion dynamic-context candidate passed 348 source tests and 347 installed tests. One upstream-source comparison was skipped only in the installed package; it passed with the upstream source present.

These checks establish the tested program boundaries and fake-backend behavior. They do not certify real-model planning quality, browser interaction, or npm publication. The prior experiment records and frozen artifacts were retained unchanged.

To reproduce this repository's checks:

```sh
npm ci
npm test
npm pack --dry-run
```

The base package has no dependency on dynamic context. Optional extension logic must register through the public workflow/session interfaces and retain its own model prompts and approval policy.
