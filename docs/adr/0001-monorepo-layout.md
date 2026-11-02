# 0001: One monorepo for backend, desktop, sidecars and eval

- Status: Accepted
- Date: 2026-11-02

## Context

SMOI has a Java backend, an Electron desktop app, optional Python ML sidecars and Python
evaluation scripts. One person builds it, and reviewers (recruiters, interviewers) should be
able to read the whole system from one link.

## Decision

Use one Git repository with top-level folders `backend/`, `desktop/`, `sidecars/`, `eval/` and `docs/`.
Each folder keeps its own build tool. CI workflows are path-filtered so a desktop change
does not rerun backend tests.

## Alternatives rejected

- **One repo per component.** Cross-cutting changes, such as an API change plus its desktop
  client, would need coordinated PRs across repos. Reviewers would have to find several repos.
- **A single multi-language build (for example Gradle or Bazel driving everything).** This adds tooling to
  learn and explain, which isn't worth it for one developer and four components.

## Consequences

- Changes that span components can land in one commit.
- Each component's tooling stays independent. The cost is one workflow file per component.
