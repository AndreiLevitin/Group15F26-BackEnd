# RevolutionInsure — Backend Team Guidelines

This file is the shared development guide for **human contributors and AI coding agents** working in the backend repository. Follow it when making changes and updating pull requests.

## 1. Project and scope

- **Stack:** Node.js, TypeScript, Vercel serverless API, Supabase PostgreSQL.
- **Architecture:** React Native/Expo frontend → backend HTTP API → Supabase. **Only the backend accesses the database.**
- **Sprint 1 goal:** Create/end trips, store uploaded GPS samples, calculate a genuine trip score from recorded data, and return its status/result to the client.
- Authentication, automatic trip detection, and advanced analytics are **outside Sprint 1 scope** unless explicitly added to the backlog.

## 2. Suggested project structure

```text
api/               # Vercel API entry points / routes
src/
  services/        # Trip lifecycle and scoring business logic
  repositories/    # Supabase database queries and persistence
  lib/             # Supabase client and shared infrastructure helpers
  types/           # Request/response and domain TypeScript types
```

**Create folders only when needed.** This is a guide, not a requirement to create empty directories. Keep Vercel routing compatible with the chosen deployment configuration.

## 3. Code conventions

- Write TypeScript and define request, response, and domain types.
- Use `camelCase` for variables/functions, `PascalCase` for type/interface names, and consistent file names within each directory.
- Keep API handlers thin: validate input, call services, and return HTTP responses.
- Keep business logic (trip lifecycle/scoring) in services and database calls in repositories.
- Do not place credentials in source code, logs, or the repository.
- Do not hardcode a trip score of 100. Use actual recorded samples and documented scoring rules.
- Invalid or insufficient data must not silently produce a valid-looking score.
- Avoid adding dependencies or abstractions without a concrete need.

## 4. Git and Azure Boards workflow

- Create **one branch per Azure DevOps Task or Bug** from the latest `main`.
- Branch format: `<type>/<ADO-ID>-<short-kebab-case-description>`.
- Examples:
  - `feature/36-start-end-trip-api`
  - `bugfix/82-incorrect-trip-status`
  - `chore/91-configure-vercel-deployment`
- Use lowercase words separated by hyphens. The number is the **Task or Bug ID** in Azure Boards.
- **Every commit message must contain `AB#<ID>`**, for example: `Implement trip state transitions AB#36`.
- **Every pull request title must contain `AB#<ID>`**, for example: `AB#36 Implement start and end trip API`.
- PR descriptions should summarize changes, testing performed, and remaining limitations. Link other related work items if needed.
- Do not push directly to `main`. Open a PR and obtain at least **one teammate review** before merging.
- Keep PRs small and focused; avoid unrelated formatting or restructuring.

## 5. API, data, and cross-repository coordination

- Agree on routes, payloads, response formats, and trip state transitions with the frontend owner before implementation.
- Make database schema changes explicitly and describe them in the PR; coordinate breaking changes across both repositories.
- Store trip samples under the correct trip ID and retain their timestamps.
- Ensure scoring runs only after the required trip samples have been stored.
- Keep trip processing state and score consistent; represent missing/insufficient data as unscored rather than as an arbitrary score.
- The course-provided test trip should use the **same scoring function** as real trips. A script or internal utility is sufficient; no upload UI is required for Sprint 1.

## 6. Security, testing, and completion

- Keep Supabase secrets and deployment credentials in environment variables; **never expose service-role credentials to the mobile app**.
- Do not commit `node_modules/`, generated output, credentials, or `.env` files. Add `.env.example` with placeholder names only when needed.
- Test changed endpoints and scoring behavior, including invalid input and insufficient-data cases.
- A task is done when its acceptance criteria are met, the related PR is reviewed/merged, and tests or manual verification are described in the PR.

## 7. Running locally

```bash
npm install
```

The repository starts as a minimal TypeScript project. Add dev/start/test scripts when the relevant API setup task introduces a runnable server or tests; do not assume these scripts already exist.
