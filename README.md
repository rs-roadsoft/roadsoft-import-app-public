# RoadSoft File Sync Utility

RoadSoft is a desktop Electron application that synchronizes `.ddd` and `.esm` tachograph files with the RoadSoft cloud server.  
It provides automatic sync scheduling, local configuration storage (SQLite), and a simple UI to manage file uploads.

---

## Features

- Authentication via **Company Identifier** and **API Key**
- Syncs tachograph files (`.ddd`, `.esm`) to RoadSoft API
- **Subfolder support:** scans the selected folder and **all nested subfolders** (up to 10 levels)
- **Auto-unzip archives:** automatically extracts `.zip` files, including **nested zips**  
  — on success the original archive is removed; on failure (e.g., password/corruption) the zip is moved to **Failed** folder
  and any partial files/folders are cleaned up
- **Upload journal (v2.2):** every file is identified by the hash of its bytes and recorded in the
  local database with the server's verdict. Before each upload the app asks the server which files it
  already has or has permanently refused (`hash-check`), and after each upload it fetches the result
  of the job. A file the server refused is kept with the server's reason and is **never sent again**;
  a file that could not be sent (network, server error) stays in the folder and is tried again on the
  following runs; after three failed attempts it is parked with the last error. Two copies of the
  same file are one upload. The **Reset history** button forgets every verdict so the whole folder
  is checked again.
- **Post-sync folder handling** — a file moves only once the platform has given its final result:  
  — **imported** files at the root are moved to **Archived**;  
  — if a file came from a subfolder, the **top-level subfolder** is moved as a whole, following the
  result of the first file in it;  
  — **refused** and parked files are moved to **Failed**;  
  — a file that is uploaded and still being processed, or not yet sent, stays where it is.  
  This is a convenience for the person looking at the folder. The journal, not the move, is what
  prevents a file from being uploaded twice — the move can fail on a synced, locked or network folder
  and the journal still holds.
- Supports automatic scheduled sync (every **1h / 12h / 24h** or **on app start**)
- Local settings and the upload history stored in **SQLite** database (Company ID, API key, folder, schedule, per-file upload results)
- Minimize to tray and **auto-launch** on system startup
- Cross-platform: **Windows** and **macOS**

---

## Tech Stack

- [Electron 19](https://www.electronjs.org/)
- [SQLite3 + Knex.js](https://knexjs.org/)
- [Axios](https://axios-http.com/)
- [electron-updater](https://www.electron.build/auto-update)
- [Bootstrap + jQuery + DataTables](https://datatables.net/)

---

### Install dependencies

npm install

### Setup local development database

For local development, you need to create a local database file:

```bash
cp app/config.db app/config_local.db
```

This creates your personal development database that won't be tracked by git.

## Start in development mode

npm run dev

## Build / Packaging (folder app, no installer)

npm run build

## Create Distributables (installers / dmg / exe)

- npm run dist
- npm run dist:mac

## Generate Client IT Specification (PDF)

```bash
npm run generate:spec
```

Produces 1-page PDF specifications for customer IT departments in three languages:

- `docs/CLIENT_SPECIFICATION_en.pdf` — English
- `docs/CLIENT_SPECIFICATION_nl.pdf` — Nederlands
- `docs/CLIENT_SPECIFICATION_de.pdf` — Deutsch

## Project Publish

npx electron-builder --win --x64 -p always
