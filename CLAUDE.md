# ListPal Backend

## Layout

- `src/`: all Lambda code (CommonJS, Node.js 20). One shared package, one zip, three handlers.
- `terraform/`: all infrastructure. Routes are declared in `terraform/locals.tf` (`lambda_routes`).
- `test/`: unit tests (`node --test`, `aws-sdk-client-mock`). It is a separate package so test-only dependencies never reach `src/node_modules` or the Lambda zip. Run `yarn install && yarn test` inside it.
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

## Keep ARCHITECTURE.md up to date

Before creating a PR, check that `ARCHITECTURE.md` reflects all the changes on the branch, and update it if it does not.
