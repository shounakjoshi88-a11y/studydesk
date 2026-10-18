# StudyDesk

StudyDesk is an Android app I built to run my college life from one place: timetable, attendance,
notes, files, PDF and image tools, to-dos, and a study chat that can lean on my own PC. It is
offline first. Almost everything runs on the phone, with no account, no ads, and no analytics.

I use it every day on my own phone, so the features are shaped by real use and not by a demo script.

## Features

**Campus**

- Weekly timetable with a reminder before each class
- Timetable scanner: photograph the notice board table and the app turns it into classes. OCR runs
  fully on the device, handles the photo in any rotation, and every row stays editable before you import
- Attendance tracker: mark present or absent in one tap, set a target percentage, and see the
  "can I skip this one" math per subject
- Optional sign in to the college Juno portal to pull attendance rows. Credentials stay on the
  phone, and one tap forgets them
- Flashcard decks and pinned notices for quick recall

**Notes**

- Markdown notes with checklists, math (KaTeX), and Mermaid diagrams
- Import from docx, PDF, and text. Export and share in one tap
- A pinned note can sit in the notification shade

**Files**

- Browse the phone, in-app folders, files pulled from a PC, and Google Drive
- Star, rename, zip, share, and a bin with restore
- Push a file straight into another tool (compress, convert, sign)

**Tools (16)**

- Smart Scan: document photo to a clean PDF, with enhance, grayscale, and black and white modes
- Sign PDF: draw a signature, place it, export
- Resume maker: a clean one page resume as docx
- Merge PDF, Split PDF, Compress PDF, Rotate pages, Sort pages, Page numbers, Watermark,
  Edit metadata, Compare PDFs, PDF to images
- Images to PDF, Resize image, Convert files (docx, xlsx, pptx, csv, pdf, images)

**To-dos**

- Tasks with due dates, reminder times, and a today view

**Ask**

- A chat screen that can talk to a model server running on my own PC, or to a hosted API with a key
  that stays on the device. A QR scanner pairs the PC side quickly

## Install

1. Open the [Releases page](https://github.com/shounakjoshi88-a11y/studydesk/releases/latest) and download the latest APK.
2. Allow installs from unknown sources when Android asks.
3. Install and open. The app needs Android 8.0 or newer.

The APK is signed with my release key. Updates installed over it have to be signed the same way.

## Build from source

You need Bun (or Node 20+), JDK 17, and the Android SDK (compileSdk 36).

```sh
bun install
bun run build          # type check plus the web bundle
bunx cap sync android  # copy the bundle into the Android project
cd android
./gradlew assembleRelease
```

The APK lands in `android/app/build/outputs/apk/release/`. Without a keystore the build still
works, it falls back to the debug key. To sign with your own key, create
`android/keystore.properties`:

```properties
storeFile=path to your .jks
storePassword=...
keyAlias=...
keyPassword=...
```

For a debug build on a device or emulator use `./gradlew installDebug`, or open the `android/`
folder in Android Studio. The web app alone runs with `bun run dev`.

## How the timetable scanner works

The photo is straightened and split into a grid, each cell is read with Tesseract (WebAssembly,
bundled, no network), and the result is validated before it becomes classes.

The details that made it survive real photos:

- The four upright rotations are all tried, so the photo does not have to face the right way up
- Cells are binarised with local background subtraction before reading, which copes with dark or
  colourful backgrounds
- Tiny time labels get a second grayscale read, and the read with the higher confidence wins
- The parser refuses slots that are not real times (minutes past 59, impossible durations), so
  noise cannot invent a 19:20 class

## Privacy

- Everything stays on the phone by default. No analytics, no ads, no account
- The portal password, the Drive client pair, and any model API key live in device storage only.
  They are sent nowhere except to the service you yourself configured, and the portal password has
  a Forget button
- The timetable scanner runs completely offline

## Tech

- React 19 and TypeScript, Vite 8, Tailwind 4
- Capacitor 8 for the Android shell
- tesseract.js 7 (WebAssembly OCR) for the timetable scanner
- pdf-lib and pdf.js for PDF work, docx, mammoth and xlsx for office files, JSZip, recharts,
  Mermaid, KaTeX, abcjs, smiles-drawer
- IBM Plex Sans and Mono, with hand made pixel art empty states

## Notes

- This is a personal project and not an official app of any college or portal. If the portal sign
  in is useful to you, use your own account and check your institution's rules first.
- The PC companion bridge and the wiring for the portal sign in are not part of this repository.
