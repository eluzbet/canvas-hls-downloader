# Canvas HLS Downloader

Firefox-only WebExtension for detecting analyzing and downloading authorized HLS videos from FIU Canvas.

## Current status

Phase 3 is ready for local Firefox testing.

It can:

- Detect pages on `https://fiu.instructure.com`.
- Observe successful `.m3u8` requests after the user grants optional stream-host access.
- Parse HLS master and media playlists.
- List available qualities and select the highest resolution.
- Download unencrypted video-on-demand MPEG-TS media playlists.
- Retry each failed media segment up to three times.
- Support ordinary segments and `EXT-X-BYTERANGE` segments.
- Write one segment at a time into Firefox Origin Private File System storage.
- Show percentage segment count downloaded size speed and status.
- Create a clean `.ts` filename from the Canvas page title and selected quality.
- Save the completed `.ts` file through Firefox Downloads.
- Cancel an active segment download or Firefox save operation.
- Delete temporary media data after completion cancellation or failure.
- Keep complete playlist and segment URLs out of the popup and console.

It does not support encrypted HLS live playlists fragmented MP4 separate audio groups playlist discontinuities pause or resume yet.

## Phase 3 architecture

- `manifest.json`: Manifest V3 settings plus the Firefox `downloads` permission.
- `lib/hls.js`: Plain JavaScript parser for master and media playlists.
- `background/background.js`: Detects playlists analyzes quality downloads MPEG-TS segments writes temporary media to OPFS and saves the final file through Firefox Downloads.
- `content/canvas-page.js`: Reports the current Canvas page title.
- `popup/`: Shows playlist metadata download progress size speed status and controls.

## Permissions

| Permission | Reason |
| --- | --- |
| `storage` | Keeps private playlist state and safe progress state in Firefox session memory. |
| `webRequest` | Observes completed HLS playlist requests without blocking or modifying them. |
| `downloads` | Saves the completed local MPEG-TS file through Firefox Downloads and cancels the save when requested. |
| `https://fiu.instructure.com/*` | Detects FIU Canvas pages and links HLS requests to the correct tab. |
| Optional `<all_urls>` | HLS playlists and media segments can come from an unknown external video host. |

The extension does not request the `cookies` permission `webRequestBlocking` or access to authentication headers.

## Privacy behavior

- No analytics or external service.
- No extension data is sent to another server.
- The extension only requests the playlists and segments that make up the selected video.
- Complete signed playlist URLs stay in `browser.storage.session` and are removed before popup messages.
- Segment URLs exist only in temporary JavaScript objects during the active download.
- Cookies and authorization headers are not read or logged.
- Console logs contain safe fields such as tab ID status segment count and byte count.
- Temporary video bytes are written to Firefox OPFS and deleted after the Firefox download finishes cancels or fails.
- The Canvas page title is used only for the local filename and popup display.

## MPEG-TS handling

Phase 3 saves compatible MPEG-TS HLS segments in playlist order as one `.ts` file. This does not require FFmpeg or a third-party JavaScript library.

Phase 3 rejects a playlist when it contains:

- HLS encryption
- A live playlist without `EXT-X-ENDLIST`
- An initialization segment
- A discontinuity
- A separate audio group
- A non-MPEG-TS container

These checks keep the first downloader limited to the stream format tested on FIU Canvas.

## Large file design

Phase 3 does not combine the entire video in JavaScript memory. Each segment is fetched separately and written to Firefox OPFS before the completed disk-backed file is passed to Firefox Downloads.

OPFS uses browser-managed storage and remains subject to Firefox storage quota. The extension checks estimated free storage when bitrate and duration are available and reports a safe error when Firefox runs out of temporary space.

Files larger than 2 GB still require a specific Firefox test before this project can claim confirmed support. The code is designed to avoid full-file RAM use but the complete OPFS-to-Downloads path must be measured with a large authorized video.

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
5. If it is not listed select **Load Temporary Add-on** and choose `manifest.json`.
6. Reload the FIU Canvas video page after the extension reloads.

The temporary extension is removed when Firefox restarts.

## Phase 3 test

1. Sign in to FIU Canvas in the same Firefox profile.
2. Open an authorized Canvas video page.
3. Reload the page and press Play.
4. Open the extension popup.
5. Select **Analyze playlist**.
6. Confirm the selected media container says `MPEG-TS` and encryption says `No`.
7. Select **Download MPEG-TS**.
8. Keep the Canvas tab open while the download runs.
9. Close and reopen the popup to confirm progress continues to appear.
10. Confirm percentage segment count downloaded size and speed update.
11. Confirm Firefox saves one `.ts` file in the Downloads folder.
12. Play the saved file in a player that supports MPEG-TS.
13. Confirm the extension console does not show a complete playlist URL segment URL token cookie or authorization header.

## Cancel test

1. Start a download.
2. Select **Cancel download** before it completes.
3. Confirm the status changes to canceled.
4. Confirm no completed `.ts` file remains from that attempt.
5. Start the download again and confirm it begins from the first segment.

## Known Phase 3 limitations

- Manifest V3 background scripts are non-persistent. Active fetch and file operations need to be tested with the popup closed for the full video duration.
- Keep the source Canvas tab open. Closing it cancels the associated download and clears private state.
- Pause and resume are not included in Phase 3.
- Interrupted downloads do not resume after a Firefox restart.
- The extension saves MPEG-TS as `.ts`. It does not remux the result into MP4.
- Fragmented MP4 requires initialization-file and fragment handling in a later phase.
- Separate audio and subtitle rendition downloads are not included.
- Encrypted streams are rejected instead of attempting decryption.
- OPFS storage quota can limit very large videos.
- Temporary installation does not fully reproduce signed-extension behavior.

## Development rules

- Plain JavaScript HTML and CSS.
- Firefox only.
- No third-party dependencies.
- No build system.
- No external server.
- No complete signed URL cookie token or authentication-header logging.
- Short comments are placed above nearly every JavaScript method.
