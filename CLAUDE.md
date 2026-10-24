# ListPal Backend

Serverless AWS backend for ListPal, defined in Terraform. Read `ARCHITECTURE.md` first for the full system map (routes, data model, cron jobs, deployment, known quirks).

## Layout

- `src/`: all Lambda code (CommonJS, Node.js 20). One shared package, one zip, three handlers.
- `terraform/`: all infrastructure. Routes are declared in `terraform/locals.tf` (`lambda_routes`).
- `test-data/`: manual DynamoDB export and import scripts (ESM). These talk to the real Dev tables.
- `bak/`: old code, gitignored. Ignore it.

## Working rules

- Never commit secrets, real exports or personal data. `test-data/exports` contains real email addresses.
- Adding an API route needs both a `lambda_routes` entry in `terraform/locals.tf` and a `case` in `src/handler.js`.
- Cron rule names are parsed by `src/score_reset.js` (`weekly`, `monthly`, `yearly`). Do not rename them without updating that file.
- Do not run `terraform apply` or any AWS write command unless explicitly asked. Running `terraform plan` is fine.
- Match the style of the surrounding code, including comment density and naming.

## Comments

- Comments explain why, not what. Do not add comments that restate the code.

## Diagrams

- Always write diagrams in Mermaid, inside a fenced `mermaid` code block. Do not use ASCII art, images or other diagram formats.
- Diagrams are encouraged wherever they aid understanding, such as request flows, data relationships, schedules and infrastructure layout.
- Keep each diagram focused on one idea, and update it whenever the code it describes changes.

## ARCHITECTURE.md must stay current

`ARCHITECTURE.md` must reflect every change in every commit. This is enforced automatically:

- `.githooks/pre-commit` runs `scripts/update-architecture.sh` on each commit.
- That script sends the staged diff to a cheap model (`haiku` via `claude -p`), which edits `ARCHITECTURE.md` and the result is staged into the same commit.
- Enable the hook once per clone with `git config core.hooksPath .githooks`.
- To use a different model, set `ARCH_DOC_MODEL` (default `haiku`). To skip in an emergency, use `git commit --no-verify`, then update the document by hand in the next commit.

When editing `ARCHITECTURE.md`, whether by hand or by the hook:

- Update only the sections affected by the change. Keep the existing structure, tables and Mermaid diagrams valid.
- Add or amend Mermaid diagrams when a change introduces a flow or relationship that is easier to see than to read.
- Do not record commit hashes. A pre-commit hook cannot know the hash of the commit it belongs to.
- Remove statements that are no longer true instead of appending corrections. Do not leave a history of changes in the document.
- If a change fixes something listed in section 10 (security and quality observations), remove or amend that item.
