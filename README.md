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
- **Server check before upload:** every file is identified by the md5 of its bytes; before uploading, the
  app asks the RoadSoft API (`hash-check`) which files it already holds or has permanently rejected and uploads only
  the rest. Files the server already has go to **Archived** without an upload; files it rejected go to **Failed**
  with the status _Rejected by server_. Two copies of one file are one upload. If the server cannot be reached the
  run is postponed and nothing is sent. The server is the only memory — nothing about files is stored locally.
- **Post-sync handling:**  
  — each synced `.ddd`/`.esm` file is moved **on its own** to **Archived**, keeping its relative path (a file from
  `vehicles/AB-12-CD/` lands in `Archived/vehicles/AB-12-CD/`); the folder it came from stays where it is;  
  — files the server has permanently rejected are moved to **Failed** the same way;  
  — a file that could not be sent (network error, server error) **stays in the folder** and is offered again on
  the next run — `Failed/` holds server verdicts and corrupted archives only
- Supports automatic scheduled sync (every **1h / 12h / 24h** or **on app start**)
- Local settings stored in **SQLite** database (Company ID, API key, folder, schedule, start-up options); auto-start is on by default and can be switched off in the app
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

## Run the tests

npm test

(Node's built-in test runner, Node 21 or newer for the dev machine; the app itself runs on Electron's bundled Node. No Electron needed for the tests.)

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
