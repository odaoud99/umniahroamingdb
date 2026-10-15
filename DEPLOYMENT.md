# Deploy with GitHub and Vercel

The Vercel deployment uses **Turso/libSQL** for durable SQLite storage. Records, logs, users, sessions, and CLL attachment chunks persist in that remote database. No production records are written to Vercel's temporary filesystem.

Online application status: **not deployed**. GitHub is connected and the source repository is [odaoud99/umniahroamingdb](https://github.com/odaoud99/umniahroamingdb). The owner explicitly authorised publishing the complete system and workbook-derived roaming data in this public repository. Sites and the Vercel integration are disabled in the current Codex workspace. Vercel account access and a Turso database are still required to host the application. Do not paste database tokens or passwords into chat.

## Prepare the repository

1. This project's chosen repository is public by the owner's explicit instruction. For other installations, select a repository visibility appropriate for the included data.
2. Push the source files in this project. The `.gitignore` excludes the original workbook, local databases, private environment files, dependencies, and screenshots. The seeded JSON contains the workbook's roaming records. Production passwords, tokens, and setup codes are not included.
3. Use the default branch as Vercel's production branch. The supplied GitHub workflow runs the regression tests on pushes and pull requests.

## Provision durable storage

1. Create a Turso/libSQL database in an organisation-approved region.
2. Obtain its database URL and an application database token through the provider's console/CLI.
3. Store the credentials only in Vercel environment variables. Do not commit them to GitHub.

The `@libsql/client/http` SDK connects over HTTPS. It runs the shared SQL statements and atomic write batches. The schema and original workbook seed are created automatically when the first API request reaches a new database. Repeated app deployments do not replace existing records or logs.

## Configure Vercel

1. Import the GitHub repository into Vercel.
2. Choose **Other** as the framework preset, **Node.js 24**, `npm run build` as the build command, and `dist/public` as the output directory. The build generates the static assets in that directory. `vercel.json` includes the API function and `/api/*` routing.
3. Add these sensitive environment variables for **Production**:

| Variable | Value |
| --- | --- |
| `TURSO_DATABASE_URL` | Database URL from Turso |
| `TURSO_AUTH_TOKEN` | Database token from Turso |
| `SETUP_CODE` | A newly generated long random private code for first-admin setup |

4. Use a separate database and setup code for preview deployments. Do not point pull-request previews at the production database.
5. Deploy. Open the HTTPS URL and create the first administrator with the setup code and a password of at least 12 characters. No default administrator password is shipped.
6. Verify the initial count is **2,193 active records / 481 TAP codes**, Camel Outbound has **229 records**, and login, attachment downloads, logs, and filtered exports work on the hosted URL.
7. Add team accounts from **User Access** and configure provider backups. Keep Vercel and database administration access with the designated owners.

For emailed password resets, follow [Microsoft 365 mail setup](MAIL-SETUP.md). Configure `APP_ORIGIN`, `M365_TENANT_ID`, `M365_CLIENT_ID`, `M365_CLIENT_SECRET` and `M365_SENDER`, redeploy, and add recovery emails to existing accounts. Direct administrator password replacement and signed-in password changes work without email configuration.

The application limits attached files to 4 MB combined per action to remain below Vercel's 4.5 MB function payload ceiling. Full hosted acceptance testing remains necessary once the accounts are available.

## Optional Cloudflare deployment

The same Worker can run on Cloudflare Workers with D1. `wrangler.jsonc` includes the Worker and assets configuration. Provision D1, replace `REPLACE_WITH_DEPLOYED_D1_ID` with its actual ID, configure a private `SETUP_CODE` secret, and deploy through your approved account. This alternative is not required for Vercel.

## References

- [Vercel Node.js runtime](https://vercel.com/docs/functions/runtimes/node-js)
- [Vercel configuration](https://vercel.com/docs/project-configuration/vercel-json)
- [Vercel function limits](https://vercel.com/docs/functions/limitations)
- [Turso TypeScript/JavaScript SDK](https://docs.turso.tech/sdk/ts/reference)
- [GSMA RAEX access](https://www.gsma.com/get-involved/gsma-membership/get-in-touch/?topic=Roaming+Gateway+Support)
