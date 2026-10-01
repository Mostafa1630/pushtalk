# AI Assistance Disclosure

AI tools assisted with analysis, implementation, testing, and documentation. The repository and the actual test results remain the source of truth; generated changes were reviewed and verified before inclusion.

| Tool                            | Contribution                                                                                                                                                                                       |
| ------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Claude (Anthropic), Cowork mode | Initial assignment analysis, architecture discussion, implementation and documentation work recorded during the original project phase.                                                            |
| GitHub Copilot                  | Follow-up work on the bilingual interface, profile and channel management, Yup validation, password changes, message-history recovery, performance checks, and the refreshed Arabic project guide. |

## Verification

The latest recorded checks on 2026-10-01 are `60` passing backend tests and `41` passing frontend tests. The frontend TypeScript check and production build also pass. The backend suite was run inside the Docker API image against the Docker test database. Vite reports an engine warning because the available Node.js version is `20.15.1`; the build still completes, but Vite recommends Node.js `20.19+` or `22.12+`.

Historical checks, including the API smoke test, browser E2E suite, and failure drills, are described with their dates and limitations in [docs/VERIFICATION.md](docs/VERIFICATION.md). Checks that were not rerun for the latest UI changes are not presented as current results.

## Review Responsibility

The project owner should understand and be able to maintain the submitted code. Review [DECISIONS.md](DECISIONS.md), run the Docker services and tests, and use the Arabic [PushTalk Project Guide](docs/PushTalk_Project_Guide.pdf) to follow the architecture, data flow, validation boundaries, and failure handling.
