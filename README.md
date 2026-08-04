# Canvas HLS Downloader

Firefox-only WebExtension for detecting HLS playlist requests made by FIU Canvas video pages.

## Current status

Phase 1 is implemented for local testing only.

It can:

- Detect pages on `https://fiu.instructure.com`.
- Observe completed `.m3u8` requests after the user grants optional stream-host access.
- Accept only HTTP status `200` playlist responses.
- Associate detected playlists with the FIU Canvas tab that requested them.
- Display the Canvas page title and a redacted stream label in the popup.
- Enable the Download button after a valid playlist is detected.
- Keep complete signed playlist URLs inside Firefox session memory only.
- Log only redacted request details.

It does not download playlist files, initialization files, media segments, subtitles, or final videos yet.

## Architecture

- `manifest.json`: Manifest V3 configuration and minimum permissions.
- `background/background.js`: Observes completed HLS requests, confirms the requesting tab is FIU Canvas, and stores per-tab state in `storage.session`.
- `content/canvas-page.js`: Reports the current Canvas page title to the background script.
- `popup/`: Displays Canvas and stream detection status.

## Permissions

| Permission | Reason |
| --- | --- |
| `storage` | Keeps detected stream state in Firefox memory for the browser session. |
| `webRequest` | Observes completed HLS playlist requests. It does not block or modify requests. |
| `https://fiu.instructure.com/*` | Detects FIU Canvas pages and associates network requests with those tabs. |
| Optional `<all_urls>` | HLS playlists may come from an unknown external CDN. Firefox requires host access to observe that cross-origin request. The extension asks for this only after the user clicks Enable stream detection. |

The extension does not request `cookies`, `downloads`, `webRequestBlocking`, or access to authentication headers in Phase 1.

## Privacy behavior

- No analytics or external services.
- No network requests created by the extension in Phase 1.
- No cookies or request headers are read.
- Complete signed playlist URLs are not shown in the popup or written to console logs.
- Complete signed playlist URLs are held only in `browser.storage.session`, which is memory-backed and clears when the browser session ends.
- The popup receives only a redacted stream label such as `video.m3u8 on example-cdn.net`.

## Project tree

```text
canvas-hls-downloader/
├── .gitignore
├── README.md
├── manifest.json
├── background/
│   └── background.js
├── content/
│   └── canvas-page.js
└── popup/
    ├── popup.css
    ├── popup.html
    └── popup.js
```

## Temporary Firefox installation

1. Open Firefox.
2. Enter `about:debugging` in the address bar.
3. Select **This Firefox**.
4. Select **Load Temporary Add-on**.
5. Open this project folder and select `manifest.json`.
6. Pin Canvas HLS Downloader to the toolbar if Firefox places it in the Extensions menu.

The temporary extension is removed when Firefox restarts.

## Phase 1 test

1. Sign in to FIU Canvas in the same Firefox profile.
2. Open an FIU Canvas video page.
3. Open the extension popup.
4. Select **Enable stream detection** and approve the Firefox permission prompt.
5. Reload the Canvas video page.
6. Press Play and wait for the video to begin loading.
7. Open the popup again.
8. Confirm the page title appears.
9. Confirm an `.m3u8` stream label appears without a query string or token.
10. Confirm the Download button is enabled.
11. Select **Inspect** for the extension in `about:debugging`, open Console, and confirm logs contain only a host, playlist filename, status code, request type, query-parameter count, and tab ID.

## Known Phase 1 limitations

- Firefox cannot expose a cross-origin HLS request through `webRequest` without host permission for the stream host and the page that initiated it.
- The CDN host is unknown before the first playlist is observed, so Phase 1 uses optional `<all_urls>` access.
- Granting access after a video already loaded does not recover earlier requests. Reload the page after granting access.
- The newest successful playlist is displayed. Quality ranking and master-playlist parsing are later phases.
- The Download button only confirms readiness. It does not start a download.
- Temporary installation does not fully reproduce signed-extension permission behavior.

## Development rules

- Plain JavaScript, HTML, and CSS.
- Firefox only.
- No third-party dependencies.
- No build system.
- No external server.
- No complete signed URL, cookie, token, or authentication-header logging.
