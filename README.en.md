# DWX Decision Workbench

> **English** | [中文](README.md)

DWX (Decision Workbench) is a decision workbench built on a **dual-engine, dual-brain architecture**.

**Dual Engines**: the **rule engine** (Drools 10.2.0) handles deterministic reasoning over rules, decision tables and decision flows; the **complex event processing engine** (Esper 8.8.0) handles real-time CEP over event streams.

**Dual Brains**: the **decision platform brain** centrally manages BOM, rules, decision tables, RuleFlow, CEP EventStreams, test suites, Change Sets, Releases, deployments and audit, and routes rule requests to Drools and CEP event-stream requests to Esper per project; the **LLM agent brain** targets intelligent rule operations — analyzing rule-hit behavior and providing tuning recommendations (see [Roadmap](#roadmap)).

The rules side uses Drools 10.2.0, and the CEP side uses Esper 8.8.0. This project is intended for local development, product validation and customer demos — it is not a public-facing commercial deployment.

Rules, decision tables and rule sets support drafts, revision history, structured diffs, change-set review, audit logs, versioned releases, history rollback, archival, dry-runs, parameterized test suites, version-behavior comparison, coverage, release gates, project knowledge-asset reports and exported DRL of published rules. Rule Project properties centrally maintain Ruleset Variables; variables live in a `RuleContext` for the duration of one execution, are not part of the BOM, are not injected via `facts`, and persist across multi-step/settle rounds; variable definitions are frozen into a Release and participate in its checksum. The CEP side supports BOM Event Profiles, EventStreams, window aggregation, pattern/timer time-driven statements, real Esper compilation and execution, webhook alerts, OpenAPI and Prometheus metrics. The Team Server supports both JSON-file and PostgreSQL storage modes.

Decision tables support inline comparators, closed and half-open intervals, empty-condition wildcard confirmation, same-type business-field comparison and hierarchical diagnostics. Rule sets freeze dependent asset versions; when a dependency is upgraded, affected releases are flagged for re-publishing, and writing the same output field from multiple steps raises an overwrite warning. Test reports keep normalized inputs and omitted fields; BOM inputs can be configured as required at execution time, and the Team Server and RES return `400` when they are missing. Optional numeric and Boolean fields use Java wrapper types in new release artifacts, staying `null` when omitted and never being confused with explicit `0`/`false`.

The "Explore" page provides a cross-project asset catalog searchable by name, rule package, project and BOM business term, with combined filters for project, asset type and status; results link directly to rules, decision tables, rule sets or BOM fields.

The product evolves along three boundaries: the rule design center, the rule governance center, and the standalone Rule Execution Center (RES). Detailed plans are in [产品需求说明](docs/product-requirements.md), [技术设计](docs/technical-design.md) and [交付任务拆分](docs/delivery-plan.md).

## Architecture

![DWX Dual-Engine, Dual-Brain Architecture](docs/images/dwx-architecture.en.svg)

As shown above, DWX follows a three-layer architecture: **client layer** (web console / business systems) → **brain layer** (decision platform brain and LLM agent brain) → **engine layer** (Drools rule engine and Esper event engine). The decision platform brain centrally governs BOM, rules, tests and release assets, routing rule requests to Drools and CEP event-stream requests to Esper per project; the LLM agent brain (roadmap) analyzes rule-hit behavior and provides tuning suggestions that flow back into the decision platform brain after human confirmation, forming a "decide → analyze → suggest → optimize" loop.

## Project structure

```text
frontend/                 # Active React + Vite frontend application
server/                   # Team Server API, auth, route modules, storage adapters and DB migrations
shared/                   # Domain logic shared by frontend/backend: rules, BOM, releases, tests, reports
  ruleset-variables.js    # Ruleset Variable types, defaults and declaration validation
engine/                   # Drools design-time Build Service
res/                      # Standalone Rule Execution Center (RES)
cep/                      # Esper CEP Build/Runtime Service
fixtures/demo-data/       # Versioned demo seed data for tests and local initialization
data/                     # Local runtime JSON storage directory (gitignored)
e2e/                      # Playwright end-to-end tests
test/                     # Node.js unit and API tests
docs/                     # Product, technical, design and user documentation
archive/legacy-prototype/ # Early single-file prototype, kept for reference only
```

`server/index.js` remains the composition entry point of the Team Server; environment configuration is split into `server/config.js`, fact-input normalization into `server/fact-parser.js`, generic HTTP utilities into `server/http-utils.js`, revision/package-name normalization into `server/domain-utils.js`, JSON/PostgreSQL read-write and audit appending into `server/storage-service.js`, the write queue and change serialization into `server/mutation-service.js`, project data queries and summary aggregation into `server/project-query-service.js`, test-target resolution, dry-runs, coverage and suite execution into `server/test-execution-service.js`, review locks and conflict-resource queries into `server/governance-service.js`, home activity aggregation into `server/activity-service.js`, project creation templates into `server/project-factory.js`, project view assembly into `server/project-presenters.js`, project compile/release orchestration into `server/project-build-service.js`, Drools/CEP clients into `server/engine-client.js`, and project routing, project management, background user directory, project rule assets/packages/rule sets/event streams, legacy-compatible APIs, BOM, Change Set, Release and test-suite routes into `server/routes/`. New APIs should be placed in `server/routes/` instead of growing the entry file.

The user manual is at `docs/user-guides/DWX决策工作台-用户操作手册.docx`.

## Running

Requires Node.js 20+ and Docker. Run `npm install` in the root for backend dependencies and `cd frontend && npm install` for the maintained frontend dependencies (root `npm run dev`/`build`/`lint` delegate via `--prefix frontend` and will not install `frontend/` dependencies automatically). `data/` is a local runtime directory and is not committed; after a fresh clone, use `fixtures/demo-data/` to initialize demo data. After starting the rule engine and CEP containers:

```bash
npm install
cd frontend && npm install && cd ..
npm run seed  # initializes data/*.json on first clone; existing files are not overwritten
docker compose up --build -d engine res cep-build cep-res
API_PORT=8789 npm run api   # Team Server; keep in sync with the frontend/ proxy port
npm run dev                 # frontend/ dev server, default http://127.0.0.1:5173
```

The capacity benchmark can be run with the commands below; by default it covers 1,000 / 5,000 / 10,000 rule assets and records Team Server, browser, DRL, Drools Build Service and RES metrics:

```bash
npm run benchmark:capacity       # full benchmark
npm run benchmark:capacity:quick # quick smoke test at the 1,000 tier only
```

Results are written to `benchmarks/capacity/results/latest.md` and `latest.json`. Benchmarks use isolated temporary data and never modify `data/`; options and pass/fail boundaries are documented in [容量基准说明](benchmarks/capacity/README.md).

A one-shot script can also initialize demo data, start Docker services, and launch the API and frontend:

```bash
npm run start
```

The script uses `API_PORT=8789` by default and can be overridden via environment variables, e.g. `API_PORT=8799 npm run start`. On exit it stops the API and frontend processes it started; Docker services keep running and can be stopped with `docker compose stop engine res cep-build cep-res`.

To reset local demo data, run `npm run seed:force` — it overwrites `data/*.json` from `fixtures/demo-data/`.

Open `http://127.0.0.1:5173` in the browser. Without `DATABASE_URL` set, `data/*.json` is used. The design-time Build Service health endpoint is `http://127.0.0.1:8788/health`. The standalone RES listens on `8790` for execution and `8793` for management; `/health` on both is anonymously probe-able, while all other endpoints require Bearer credentials from `RES_EXECUTION_API_KEY` and `RES_MANAGEMENT_API_KEY`. The Team Server reads `RULES_RES_URL`, `RULES_RES_MANAGEMENT_URL`, `RULES_RES_EXECUTION_API_KEY` and `RULES_RES_MANAGEMENT_API_KEY`; the legacy `RES_URL` remains supported for single-port deployments. Empty keys are for local migration compatibility only — production must configure two distinct keys. The RES Drools session pool size is configured in `res/config/res.properties`, defaulting to `2` sessions per release step.

For release-environment integration, two additional isolated RES instances can be started with `docker compose up --build -d res-test res-production`. Their execution/management endpoints are `http://127.0.0.1:8800` / `http://127.0.0.1:8803` (test) and `http://127.0.0.1:8810` / `http://127.0.0.1:8813` (production simulation), each with its own data volume; when creating `test` and `production` Targets in the release center, fill in the management address and use the corresponding execution address for business verification.

CEP container health endpoints are `http://127.0.0.1:8791/health` (Build/Test) and `http://127.0.0.1:8792/health` (Runtime). The CEP Runtime supports `/events/{releaseId}`, `/execute`, `/webhook`, `/openapi.json` and `/metrics`. `timer:*` uses Esper processing time and does not replay by the event's `eventTime`; timer output after deployment can be received asynchronously via webhook.

PostgreSQL mode:

```bash
docker compose up -d postgres
export DATABASE_URL=postgresql://rules:rules-local@127.0.0.1:54329/rules
npm run db:migrate
npm run db:import-json  # first migration only; refuses non-empty targets
npm run api
```

`GET /api/system/storage` confirms the current storage mode. `npm test` runs the default model and API tests; when the database is available, run the isolated PostgreSQL integration tests with `POSTGRES_TEST_URL=$DATABASE_URL node --test test/postgres-storage.test.js`. `npm run build` builds the frontend.

The default `AUTH_MODE=local` is for local development only. Management APIs can switch to `AUTH_MODE=oidc`, which requires `OIDC_ISSUER` and `OIDC_AUDIENCE`; the service discovers JWKS via OIDC discovery and validates Bearer JWTs, or you can override with `OIDC_JWKS_URI`. Built-in roles are `viewer`, `author`, `reviewer`, `release-manager`, `admin`, and top-level `roles`, Keycloak realm roles and client roles for a given `OIDC_CLIENT_ID` are supported. The browser uses Authorization Code + PKCE to establish an HttpOnly BFF session; `GET /api/session` returns the current authenticated principal and permissions.

The backend default port is `8787` (overridable with `API_PORT`), while the `/api` proxy in `frontend/vite.config.ts` points to `http://127.0.0.1:8789`. For local integration keep them aligned: `API_PORT=8789 npm run api`. `API_TARGET` is only read by the legacy entry `npm run dev:legacy` (`archive/legacy-prototype/`, defaulting to `8787`) and has no effect on `frontend/`. The frontend default port is `5173`; to change it use `cd frontend && npm run dev -- --port 5175`. The legacy prototype defaults to port `5174` to avoid clashing with the main frontend.

Container base images are pulled from `docker.1ms.run` by default, and build stages use the Aliyun Maven public repository via `engine/settings.xml`, without modifying the Docker daemon or global Maven config. If the mirror is unavailable, use the Docker build args `BUILD_IMAGE` and `RUNTIME_IMAGE` to specify other accessible image addresses. `registry.cn-hangzhou.aliyuncs.com` is an Aliyun container registry and cannot simply be substituted for Docker Hub `library/...` paths.

## Boundaries

- Currently a single-workspace, multi-project prototype. Management APIs already support OIDC JWT verification, browser BFF sessions, role gates and policy-based project/asset authorization. PostgreSQL covers projects, packages, assets, draft revisions, release versions, BOM, test reports, Releases, deployment receipts, Change Sets and audit events; workspace-level multi-tenancy isolation and backup/recovery are not yet implemented.
- Rules, decision tables, rule sets and test suites use `revision`; the BOM uses `version` as the optimistic lock. Conflicts return `409` with the current revision and server snapshot; the frontend keeps local edits and lets the user decide whether to load the server version. Draft ownership, field-level merging and real-time collaboration are not yet implemented.
- The project "Review" page fixes up to 50 current asset revisions into a Change Set, compares structured field diffs between the latest release and drafts, and runs a draft → pending-review → approved → rejected state flow. Single assets can be submitted for review directly from the BAL/decision-table editors; assets under review are locked with their package structure, are recompiled at the fixed revision before approval, and only then generate a release version. OIDC mode prevents submitters from approving their own changes; `local` mode keeps admin self-review for local development.
- The field dictionary (BOM) lives in `data/bom.json` and is managed via the "Field Model" page or `GET/PUT /api/bom`; it currently includes 5 inputs (customer age, annual income, credit score, customer type, overdue flag) and 3 outputs (risk level, manual review, approved amount). The DRL `declare RuleInput` block is generated dynamically from the BOM and frozen with the Release; the Build Service and RES reflect field types from compiled FactTypes and do not store BOM copies.
- `variables` in Rule Project properties are the formal entry point for Ruleset Variables (supports `Integer`, `Double`, `Boolean`, `String` and String enums); rule A in a rule set can assign, rule B can read. The BAL and decision-table editors can select project variables in conditions and actions; rule-level `variables` remain a compatibility declaration for standalone rule release. Rule conditions read with `fieldSource: "variable"` and rule actions write to the same source; variables generate a separate `declare RuleContext`, initialized to defaults by RES in one `/execute` request and carried across steps and settle rounds, echoed back through `variables` and trace snapshots.
- Ruleset Variables are not runtime task parameters: they cannot be injected via `facts`, do not persist across requests, and do not replace the BOM. The rule set is the minimal release and execution unit; project variables are preferred for rule, decision-table and rule-set releases, with legacy rule/rule-set variables as a compatibility fallback. Full requirements are in [规则集内部变量需求](docs/requirements-rule-parameters.md).
- Each project can independently create, edit, run and archive test suites; JSON mode stores them in `data/test-suites.json` isolated by `projectId`, and PostgreSQL mode isolates by `project_id`. Suites only run the project's published assets and support BOM-driven parameter datasets, output/hit-rule/rule-set-path assertions, parallel comparison of published versions, and rule/decision-table-row/rule-set-path coverage. Suites marked as release-required are re-run on every Release creation of the project and block release on failure.
- Conditions and actions support BOM business fields and Ruleset Variables; BOM field actions still write output-field constants, while Ruleset Variable actions write to the current execution's `RuleContext`. Project settings maintain unified variable definitions; the BAL/decision-table editors only select variables. DRL output uses the declarative `RuleInput` fact; integrate business data through field mapping.
- Decision tables are Chinese structured table editors: each enabled row becomes one generated DRL rule and participates in global release compilation and export. The editor supports XLSX/CSV import/export, column-match validation and row-level diff preview before applying.
- Rule sets support public linear steps, a single exclusive condition gateway, default branches and node input/output mappings; every release freezes referenced asset versions, DRL, routing and mappings, and dry-runs return per-node traces. It is not a BPMN/jBPM flow — no multi-level/parallel gateways, human tasks, approvals or timers.
- `engine/` is a design-time service that compiles temporary DRL; `res/` is a standalone execution project that only accepts Team Server-generated, checksum-valid Releases. Both are for local prototyping only — auth, signing, isolation and execution quotas are not yet implemented and neither should be exposed to the public internet.
- The early single-file prototype has been moved to `archive/legacy-prototype/` and is no longer the default entry, reachable only via `npm run dev:legacy`; the maintained frontend is in `frontend/` and root `dev`/`build`/`lint` point to it.
- `fixtures/demo-data/` is commit-able demo seed data, while `data/` is a gitignored local runtime JSON directory; default demo-data compatibility checks in tests read `fixtures/demo-data/` so a clean clone does not depend on local machine state.
- Decision tables support up to 10,000 rows; beyond 500 enabled rows, per-row validation still runs but quadratic overlap, unreachability and gap analysis are skipped with a warning. Large-capacity compilation can be tuned via `ENGINE_MAX_BODY_BYTES`, `ENGINE_MAX_DRL_CHARS`, `RES_MAX_BODY_BYTES`, `RES_MAX_DRL_CHARS` and `RES_MAX_TOTAL_DRL_CHARS`, defaulting to 16 MiB / 12 MiB / 16 MiB / 12 MiB / 48 MiB; the services clamp these within safe ranges.

## Project report

`GET /api/projects/{projectId}/report` generates a self-contained HTML project knowledge-asset report with six sections: project overview, BOM asset overview, rule asset inventory, rule-set execution topology, test matrix, and release/deployment history. Rule sets prefer the published snapshot and fall back to drafts when unpublished; empty states are shown when there are no assets, tests or releases. The project report page supports downloading HTML and saving to PDF via the browser print dialog.

## Roadmap

**LLM-agent-driven rule operations loop**: with the dual engines continuously producing decision results, the LLM agent brain takes over the analysis side of rule operations — based on rule-hit behavior (hit rate, miss distribution, anomaly alerts, CEP event-stream output) it automatically analyzes rule quality and execution effectiveness, identifies redundant, conflicting, stale or obsolete rules, and provides tuning recommendations grounded in business semantics; after human confirmation, suggestions flow back into the rule engine, forming a "decide → analyze → suggest → optimize" loop. Longer term, it will support natural-language interactive rule insights, anomaly attribution and rule-change impact estimation.

## Open-source license

This project is open-sourced under the [GNU General Public License v3.0](LICENSE) (GPL-3.0). You are free to use, modify and distribute it, but any derivative work based on this project must be open-sourced under the same license.
