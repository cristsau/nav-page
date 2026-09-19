# Personal Dropbox file library

The `/files` page is for the NAV administrator bound to a **separate Full Dropbox app**. The backup App Folder credential is never reused. Only these personal scopes are supported: `account_info.read`, `files.metadata.read`, `files.content.read`, `files.content.write`. No team, sharing, permanent-delete or account-write scopes are required.

## Supported

- Nonrecursive directory browsing, filename search and bounded pagination.
- Create folders, upload (20 MiB/file, no overwrite), rename/move (no overwrite/ownership transfer), and revision-bound file deletion with typed-name confirmation. No recursive folder deletion.
- Session-authenticated streaming and single HTTP Range requests for native image/video/audio preview. No public media links, server transcoding, or offline file cache.
- UTF-8 text/Markdown/JSON editing up to 1 MiB, revision-conditional saves, local-in-memory dirty draft retained on conflicts. HTML/SVG are download-only. Office/PDF opens in Dropbox; no embedded Office editor is claimed.

## Connection

Run `Connect-NavDropboxFiles.cmd` on the operator's Windows computer. Confirm the independent application and personal account. PKCE callback: `http://127.0.0.1:53682/dropbox/callback`. Keep public clients allowed. Credentials are encrypted for the current Windows user; no token/secret should be pasted into NAV or chat.

Server installation is a separate authorized operator procedure. The API loads `<NAV_MANAGED_INTEGRATIONS_DIR>/dropbox-files.json`, a regular owner-only file (0600 on Linux, API process UID, no hardlinks/symlink). Schema version 1 requires `purpose=nav-files`, `accessType=full_dropbox`, exact `ownerUserId`, separate `clientId` / `backupClientId`, `refreshToken`, `accountId`, the four scopes, `backupFolderId`, and `backupFolderPath`. This is a private server configuration, never a repository file or environment dump. The connection is reloaded per operation; deletion disables the library without modifying the backup app.

Every operation resolves the backup folder's stable ID and protects both its original and current paths. Ancestors cannot be renamed/moved. If protection cannot be established, operations fail closed. Simultaneous moves performed outside NAV cannot be made transactional with Dropbox API operations; do not relocate the backup tree during file operations.

## Verification and limits

Run `api/test/dropboxFiles.test.js` and `api/test/dropboxFilesRoute.test.js`. `scripts/verify-dropbox-files-ui.mjs` exercises the real Vue component with synthetic API responses and generated WebM, no personal cloud access. Set `NAV_FILES_UI_EVIDENCE`, `NAV_PLAYWRIGHT_MODULE`, and `NAV_BROWSER_PATH` to isolated test locations. Linux file-permission/symlink tests must run before release.

Mock tests do not prove a real account is Full Dropbox or a production installation is correct. Real acceptance must verify the exact account/application, bind the existing backup folder, and use only an explicitly authorized synthetic fixture directory for writes. Existing personal files and backup contents are out of the test-write scope. Media compatibility depends on the browser codec; unsupported video falls back to download/Dropbox.

API policy: 120 requests/minute for the bound owner, four active metadata/operation handlers, two streaming downloads, two concurrent large-body requests reserved before parsing. Requests are not automatically retried on ambiguous mutations. Filenames/content/provider errors and raw pagination cursors must not enter operational logs.
