# RoadSoft File Sync Utility

RoadSoft is a desktop Electron application that synchronizes `.ddd` and `.esm` tachograph files with the RoadSoft cloud server.  
It provides automatic sync scheduling, local configuration storage (SQLite), and a simple UI to manage file uploads.

---

## Features

- Authentication via **Company Identifier** and **API Key**
- Syncs tachograph files (`.ddd`, `.esm`) to RoadSoft API
- Supports automatic scheduled sync (every 1h / 12h / 24h / app start)
- Local settings stored in **SQLite** database
- Minimize to tray and auto-launch on system startup
- Auto-updater and logging support
- Environment-aware API (Staging / Production)

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

## Start in development mode

npm run dev

## Build / Packaging (folder app, no installer)

npm run build

## Create Distributables (installers / dmg / exe)

- npm run dist
- npm run dist:mac

## Project Publish

npx electron-builder --win --x64 -p always
