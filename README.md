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
- **Smart post-sync handling:**  
  — synced files at the root are moved to **Archived**;  
  — if a file came from a subfolder, the **top-level subfolder** is archived as a whole;  
  — failed items are moved to **Failed**
- Supports automatic scheduled sync (every **1h / 12h / 24h** or **on app start**)
- Local settings stored in **SQLite** database (Company ID, API key, folder, schedule)
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

## Project Publish

npx electron-builder --win --x64 -p always
