# Inbox Coupon Assistant

A self-hosted Chrome extension that reads your Gmail Promotions category and
collects coupon codes into a local, searchable list. Local-first: no app
backend, no hosted service, no telemetry. You supply your own Google OAuth
client and, from phase 4 onward, your own LLM API key.

Full design in [COUPON-EXTENSION-DESIGN.md](COUPON-EXTENSION-DESIGN.md).

**Status: Phases 1–7 are implemented.** Automated type, unit and build checks
pass. The final account-level checks still require your real Google client ID,
Gmail test user and one configured LLM provider key — and the OCR stage in
particular needs a real Chrome to confirm, since nothing in a Node test suite
exercises the offscreen document or the Tesseract worker it hosts.

The extension currently:

- connects to Gmail with read-only OAuth and immediately starts a background
  Promotions scan;
- resumes bounded scan slices through Chrome alarms even when the popup closes,
  and checks the rolling mail window again every five minutes;
- decodes Gmail MIME content and extracts coupon candidates from links, image
  alt text, subjects and body text without a DOM or network parser;
- displays strong link/alt-text results without an API key and uses Anthropic,
  OpenAI or Google Gemini to validate and enrich all candidate sources when a
  provider key is configured;
- stores processed-message records and deduplicated offers in local IndexedDB;
- keeps provider settings and the user-supplied API key in local extension
  storage, while returning only a masked key to the settings page; and
- answers natural-language questions from the complete active-offer table,
  rendering validated coupon cards from IndexedDB rather than model-written
  code strings; and
- preserves the latest 20 chat turns when the popup closes.

The popup has no scanning controls. It contains only Connect when Google access
is absent, a compact background-progress strip, the coupon chat, and a Settings
gear. The current five-minute refresh re-lists the configured rolling window
and the incremental loop below keeps it cheap. Each sync also removes offers
whose known expiry is more than 30 days old.

Each sync walks Gmail's history from the cursor stored by the last full scan,
processes anything new, and only then spends what is left of its budget on the
older backfill, so today's coupons never queue behind historical mail. The
cursor advances only once every discovered message is terminal. When it outlives
Gmail's retention the extension falls back to re-listing the rolling window,
which section 6 treats as routine rather than as an error.

OCR is part of the extraction cascade rather than an option. When the link,
alt-text and body-text stages find no code, the largest one or two images in
the message are read with bundled Tesseract and the recovered text re-enters
candidate detection. A code read this way is always flagged for review, and a
read the engine was not confident about yields nothing rather than a code that
would fail at checkout. `npm run vendor:ocr` (run automatically before a build
and before `npm run dev`) places the engine and language data in
`public/vendor/tesseract/`; they are roughly 11MB and deliberately not
committed.

### OCR privacy boundary

OCR reads only images the sender **inlined into the message**, which Gmail
serves and which tell the sender nothing. Remote CDN banners are deliberately
out of scope for now: fetching one can register an email open, and this simple
extension does not request broad website access for a feature it cannot explain
or control in its Settings UI.

## Requirements

- Node 22.12 or newer (`.nvmrc` pins 24 for local development)
- Chrome 120 or newer
- A Google account, and a Google Cloud project you create yourself

## Google Cloud setup

This build's extension ID is pinned by the `key` in `manifest.template.json`,
so it is stable no matter where the folder lives and you do **not** need to load
the extension first to discover it:

```
bjbhbbododfldjjknhanpohghijlgpcc
```

1. Open [Google Cloud Console](https://console.cloud.google.com/), create a
   project (or select one dedicated to this extension), and keep it selected.
2. Open **APIs & Services → Library**, search for **Gmail API**, open it and
   click **Enable**.
3. Open **Google Auth Platform → Branding** and configure the app name plus
   your support/developer email. Choose **External** unless this is restricted
   to your own Google Workspace organization.
4. Open **Google Auth Platform → Data Access**, add
   `https://www.googleapis.com/auth/gmail.readonly`, and save.
5. Open **Google Auth Platform → Audience**, leave publishing status as
   **Testing**, and add the Gmail address you will use under **Test users**.
6. Open **Google Auth Platform → Clients**, click **Create client**, choose
   **Chrome Extension**, give it a recognizable name, and enter this extension
   ID as the Item/Application ID:

   ```text
   bjbhbbododfldjjknhanpohghijlgpcc
   ```

7. Click **Create** and copy the generated client ID. It ends in
   `.apps.googleusercontent.com`.
8. Copy `.env.example` to `.env` and replace its placeholder:

   ```dotenv
   GOOGLE_CLIENT_ID=your-client-id.apps.googleusercontent.com
   ```

9. Run `npm run build`, load `dist/` from `chrome://extensions`, open the popup
   and click **Connect Google**.

### There is no client secret

Choose the **Chrome Extension** client type, not **Web application**. A Chrome
extension is a public client: anyone can inspect its installed files, so it
cannot protect a client secret. Google/Chrome authentication for this project
uses only the client ID and scopes from the manifest through
`chrome.identity.getAuthToken()`. Do not put a client secret in `.env`, the
manifest or the TypeScript bundle.

Client IDs are not secrets, but each Chrome Extension client ID is bound to one
extension ID, so a build with a different ID cannot use it.

Because the OAuth app stays in Testing status, authorization for
`gmail.readonly` expires after seven days. The extension treats that as a
normal disconnected state and shows Connect again — weekly reconnection is
expected, not a bug.

## Build and load

```bash
npm install
npm run build
```

Then in Chrome: `chrome://extensions` → enable **Developer mode** → **Load
unpacked** → select the generated `dist/` directory.

For iterative work use `npm run dev`, which rebuilds on save with readable
output and source maps. Chrome still needs a manual reload of the extension to
pick up a new service worker.

## Scripts

| Command | What it does |
|---|---|
| `npm run dev` | Watch build: readable output, source maps, no minification |
| `npm run build` | Production build: minified, no source maps |
| `npm run typecheck` | `tsc --noEmit` — Vite transpiles but never type-checks |
| `npm test` | Node's built-in test runner over `test/**/*.test.ts` |
| `npm run check` | Type-check, then tests |
| `npm run extension-id` | Print the extension ID derived from the pinned key |

## Layout

```
manifest.template.json   committed; dist/manifest.json is generated from it
vite.config.ts           entry points, manifest generation, mode-dependent output
key.pem                  private key backing the pinned extension ID — gitignored
src/background/          service worker: auth, Gmail, message routing
src/popup/               plain HTML/CSS/TS popup
src/types/               shared TypeScript-only contracts; no runtime code
src/utils/               reusable runtime functions; no type contracts
scripts/extension-id.ts  derives the extension ID from the manifest key
test/                    node:test suites, no browser and no network
```

### About `key.pem`

`key.pem` is a local RSA **private key**. Its public half is the long, non-secret
`"key"` value committed in `manifest.template.json`; Chrome hashes that public
key to derive the stable development extension ID shown above.

Vite, the unpacked `dist/` build, OAuth and normal development do not read
`key.pem`. Keep it only if you may later sign and pack a self-hosted `.crx` with
the same signing identity. It is gitignored, currently permissioned for only
the local user, and must never be committed or shared. Deleting it does not
change the unpacked extension ID because the public manifest key remains. The
ID changes only if that manifest key is replaced.

If the extension is later published through the Chrome Web Store, use the
public key/ID assigned to that store item for local development and create a
matching Chrome Extension OAuth client. Do not upload this private PEM as part
of the extension source or zip.
