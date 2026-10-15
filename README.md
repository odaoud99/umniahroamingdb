# Umniah Roaming Database

A searchable roaming partner database with an Umniah-inspired navy, red, and white interface. The supplied workbook is imported without changing the original file.

The initial database contains **2,193 records, 481 TAP codes, and seven service sheets**. All populated source rows are retained, including two duplicates. Search and export include TAP code, IMSI prefix, country, service, direction, and status.

## Run on this computer

Requires Node.js 24 (already available on the build computer). No package installation is needed for local use.

Double-click `Start-Umniah.cmd`, or run:

```powershell
npm run dev
```

Open http://127.0.0.1:8787. On the first visit, create your administrator account using the private `SETUP_CODE` in `.dev.vars`. Choose your own username and password. Keep that file private. Local data is stored in `data/roaming.sqlite`; the server must keep running while you use the app.

The local server listens only on this computer. Online deployment instructions are in [DEPLOYMENT.md](DEPLOYMENT.md).

## Features

- **Database:** search, combined filters, quick Camel Outbound / LTE Outbound views, pagination, selection, partner details, and active/terminated records.
- **New RP Launch:** requires TAP, IMSI, service, direction, reason, and executor. Optional CLL attachments. Identical active combinations are rejected.
- **Terminate RP:** selects an exact active record and requires reason/executor. Removes it from the active directory while retaining its snapshot, history, and attachments. Other services and prefixes stay active.
- **Logs:** server-generated UTC timestamps, displayed in Asia/Riyadh (UTC+3); reason, executor, signed-in account, record snapshot, and documents. Date, action, and text filters. Database triggers prevent ordinary audit-log editing/deletion.
- **CLL Attachments:** search and download original files. Up to three attachments per action, **4 MB combined**. Attachments are stored transactionally in database chunks and retained after termination.
- **Export Data:** all database records (including terminated), matching filters across every page, or selected records. CSV opens in Excel; JSON retains all detail. Export activity is logged.
- **Country Agent:** all 481 codes researched. **472 inferred country associations, 9 unresolved, 0 authenticated RAEX verifications.** Labels and source notes remain visible. Import an authorised RAEX CSV with `TAP Code,Country` headers, source reference, reason, and executor to update mappings. Updates retain before/after details in Logs.
- **My account:** users change their own password after confirming the current password and save their recovery email. Password changes sign the account out on every device.
- **User Access:** administrators create viewer, editor, and administrator accounts, reset any account's password, update recovery emails, and request emailed reset links. Administrator password confirmation and a reason are required for resets. Actions are audited without logging credentials or reset URLs.
- **Forgotten passwords:** users request a single-use, 30-minute email reset link. Microsoft 365 sending must be configured and a recovery email saved on the account; see [MAIL-SETUP.md](MAIL-SETUP.md). Passwords are salted PBKDF2 hashes; sessions last 12 hours, use HttpOnly/SameSite cookies, and use Secure cookies on hosted HTTPS.

## Country research

The requested research agent has created `data/tap_countries.json`, `data/iso_countries.json`, and [country-research.md](data/country-research.md). It does not have an authenticated RAEX account/API. GSMA access is limited to authorised members with approved roles. Prefix inference is not represented as RAEX verification.

Unresolved / international codes: AAZTD, AAZTR, AAZVF, ARETH, EMNDE, MLTMA, MTX02, NORMC, TELA1. An authorised RAEX export is needed to finish the requested authoritative enrichment. The CSV import validates format and records the authenticated user's assertion of RAEX provenance; it cannot independently authenticate a manually supplied export.

## Build and verify

```powershell
npm run build
npm test
```

Local tests use an isolated temporary SQLite database. They cover source counts, authentication, mandatory notes, duplicate rejection, concurrent termination, attachment fidelity, retained audit history, exports, roles, rejected cross-origin mutations, and audit immutability. The shared Turso adapter is tested against a transactional SQLite stand-in. A live Vercel/Turso deployment has not been verified without account access.

## Data and backups

The original workbook remains untouched. `data/import-report.json` records sheet counts and the source SHA-256. Seeding runs once per database and preserves all source rows. New launches, terminations, country imports, account creation, and exports are stored in the database, independently of the browser. Clearing browser storage does not remove the database.

For local backups, stop the server and copy `data/roaming.sqlite` plus any accompanying `-wal` / `-shm` files into a secured backup location. Hosted database backups must be configured in the chosen provider. CSV/JSON exports contain partner records; they do not substitute for a full backup of users, logs, and attachments.
