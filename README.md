# Canvas HLS Downloader

Firefox-only WebExtension for detecting and analyzing HLS playlist requests made by FIU Canvas video pages.

## Current status

Phase 2 is implemented for local testing.

It can:

- Detect pages on `https://fiu.instructure.com`.
- Observe completed `.m3u8` requests after the user grants optional stream-host access.
- Accept only HTTP status `200` playlist responses.
- Associate detected playlists with the FIU Canvas tab that requested them.
- Display the Canvas page title and a redacted stream label in the popup.
- Fetch captured playlists again from the Firefox background extension context.
- Parse HLS master playlists and media playlists.
- List available variant qualities from `EXT-X-STREAM-INF`.
- Select the highest resolution and then the highest bandwidth.
- Parse media segment counts, estimated duration, initialization-map presence, encryption methods, and container type.
- Keep complete signed playlist URLs inside Firefox session memory only.
- Log only redacted request and analysis details.

It does not download initialization files, media segments, subtitles, or final videos yet.

## Phase 2 architecture

- `manifest.json`: Manifest V3 settings and extension permissions.
- `lib/hls.js`: Plain JavaScript HLS parser for master and media playlists.
- `background/background.js`: Detects successful playlists, fetches them for analysis, chooses the highest quality, and stores per-tab state in `storage.session`.
- `content/canvas-page.js`: Reports the current Canvas page title.
- `popup/`: Shows detection status, playlist metadata, quality, segment count, duration, container type, and encryption status.

## Permissions

| Permission | Reason |
| --- | --- |
| `storage` | Keeps detected stream and analysis state in Firefox memory for the browser session. |
| `webRequest` | Observes completed HLS playlist requests. It does not block or modify requests. |
| `https://fiu.instructure.com/*` | Detects FIU Canvas pages and associates network requests with those tabs. |
| Optional `<all_urls>` | HLS playlists may come from an unknown external CDN. Firefox requires host access to observe and fetch that cross-origin resource. |

The extension does not request `cookies`, `downloads`, or `webRequestBlocking` in Phase 2. The manifest declares `data_collection_permissions.required` as `none` and requires Firefox 140 or later.

## Privacy behavior

- No analytics or external services.
- No cookies or request headers are read directly.
- Background playlist fetches use Firefox's existing credentials when browser policy allows them.
- Complete signed playlist URLs are not shown in the popup or written to console logs.
- Complete signed playlist URLs are held only in `browser.storage.session`.
- Playlist text and segment URLs are parsed in memory and discarded after analysis.
- The popup receives only redacted stream labels and nonsecret playlist metadata.
- Errors are converted to safe codes and messages before logging.

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
├── lib/
│   └── hls.js
└── popup/
    ├── popup.css
    ├── popup.html
    └── popup.js
```

## Temporary Firefox installation

1. Open Firefox.
2. Enter `about:debugging` in the address bar.
3. Select **This Firefox**.
4. Find Canvas HLS Downloader and select **Reload**.
5. If it is no longer listed, select **Load Temporary Add-on** and choose `manifest.json`.
6. Reload the FIU Canvas video page after the extension reloads.

The temporary extension is removed when Firefox restarts.

## Phase 2 test

1. Sign in to FIU Canvas in the same Firefox profile.
2. Open an FIU Canvas video page.
3. Open the extension popup and confirm stream access is enabled.
4. Reload the page and press Play.
5. Wait until an `.m3u8` stream appears in the popup.
6. Select **Analyze playlist**.
7. Keep the popup open while it reads the captured playlists.
8. Confirm the popup shows a playlist type.
9. For a master playlist, confirm available qualities and a selected highest quality appear.
10. Confirm segment count and estimated duration appear when the selected media playlist can be read.
11. Confirm the container says `fragmented MP4`, `MPEG-TS`, `AAC`, or `unknown`.
12. Confirm no signed URL or query value appears in the popup or extension console.

## Known Phase 2 limitations

- `webRequest.onCompleted` reports request completion but does not provide the response body, so Phase 2 fetches the playlist a second time for parsing.
- A second request may fail when a server requires the exact original page request context, a short-lived token, a particular Referer header, or blocked third-party cookies.
- Extension `fetch()` cannot set an arbitrary Canvas page URL as the Referer because Fetch only permits same-origin custom referrer values.
- When the highest variant media playlist cannot be read, Phase 2 can still report the highest quality found in the master playlist as a partial result.
- When no master playlist is available, quality may be inferred from observed names such as `480.m3u8`.
- The parser does not download segments or combine media.
- The parser does not yet handle alternate audio groups, subtitle groups, live playlist refreshes, low-latency HLS parts, or encrypted media decryption.
- Temporary installation does not fully reproduce signed-extension permission behavior.

## Development rules

- Plain JavaScript, HTML, and CSS.
- Firefox only.
- No third-party dependencies.
- No build system.
- No external server.
- No complete signed URL, cookie, token, or authentication-header logging.

