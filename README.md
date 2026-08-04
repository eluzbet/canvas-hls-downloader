# Canvas HLS Downloader

Firefox-only WebExtension for detecting analyzing and downloading authorized video sources from FIU Canvas.

## Current status

Phase 4A is ready for local Firefox testing.

It can:

- Detect FIU Canvas pages.
- Detect multiple embedded videos in one Canvas tab.
- Keep each detected video in a separate popup selection.
- Detect HLS from `.m3u8` paths or HLS response content types.
- Detect Kaltura `playManifest` and `serveFlavor` traffic.
- Detect MPEG-DASH manifests.
- Detect direct MP4 and MOV responses.
- Group Kaltura requests by iframe or private entry information.
- Parse HLS master and media playlists for the selected video.
- Select the highest HLS quality.
- Download supported unencrypted MPEG-TS HLS videos from Phase 3.
- Keep signed URLs private.

Phase 4A detects direct MP4 MOV and MPEG-DASH sources but does not download them yet. MP4 output and local MPEG-TS to MP4 remuxing are planned for Phase 4B.

## Phase 4A architecture

- `manifest.json`: Manifest V3 settings and background script order.
- `lib/hls.js`: HLS master and media playlist parser from Phase 2.
- `lib/media.js`: Request classification for HLS Kaltura DASH direct MP4 and direct MOV.
- `background/background.js`: Groups requests into videos stores per-video state analyzes selected HLS and keeps Phase 3 MPEG-TS downloading.
- `content/canvas-page.js`: Reports the current FIU Canvas page title.
- `popup/`: Shows a video selector safe source details analysis progress and download controls.

## Request grouping

Firefox gives network requests a tab ID and frame ID. Phase 4A uses the subframe ID first because embedded video players normally run inside separate iframes. It uses a private Kaltura entry ID when requests happen in the main frame. These private grouping values stay in Firefox session storage and are not sent to the popup or logs.

The popup uses simple local labels:

```text
Video 1 · Kaltura · HLS
Video 2 · Kaltura · Direct MP4
Video 3 · Kaltura · MPEG-DASH
```

The order is based on the first successful media request seen from each player.

## Detected source types

| Source | Detection | Phase 4A action |
| --- | --- | --- |
| HLS | `.m3u8` URL HLS content type or Kaltura applehttp path | Analyze and download supported MPEG-TS |
| MPEG-DASH | `.mpd` URL DASH content type or Kaltura mpegdash path | Detect only |
| Direct MP4 | `.mp4` URL or MP4 content type | Detect only |
| Direct MOV | `.mov` URL or QuickTime content type | Detect only |

MPEG-TS segment responses are ignored by source detection so every segment does not appear as another video.

## Multi-video behavior

1. Open the Canvas page.
2. Press Play on the first embedded video.
3. Open the popup and confirm Video 1 appears.
4. Press Play on the second embedded video.
5. Confirm Video 2 appears.
6. Repeat for every player on the page.
7. Use the selector to change the video controlled by Analyze and Download.

The extension does not auto-play videos. A player must request its media before Firefox can report the source.

Only one download can run in a Canvas tab at a time. The video selector stays disabled during an active download.

## Existing MPEG-TS download support

For a selected HLS video Phase 4A keeps the tested Phase 3 download path:

- Select the highest HLS quality.
- Reject encryption live playlists initialization segments discontinuities and separate audio groups.
- Fetch MPEG-TS segments in order.
- Retry failed segments up to three times.
- Write temporary bytes to Firefox OPFS.
- Save one `.ts` file through Firefox Downloads.
- Show progress size speed and status.
- Cancel an active download.

When a page contains multiple videos the local filename includes `Video 1` `Video 2` and so on to reduce filename collisions.

## Permissions

| Permission | Reason |
| --- | --- |
| `storage` | Keeps private per-video state in Firefox session memory. |
| `webRequest` | Observes completed video requests and reads safe response content types. |
| `downloads` | Saves the completed MPEG-TS file through Firefox Downloads. |
| `https://fiu.instructure.com/*` | Detects FIU Canvas tabs. |
| Optional `<all_urls>` | Video hosts can use external CDNs that are not known in advance. |

Phase 4A adds no new permission compared with Phase 3.

## Privacy behavior

- No analytics.
- No external service.
- No extension data upload.
- No `cookies` permission.
- No authentication-header reading.
- No response body logging.
- Complete playlist direct media and segment URLs stay private.
- Kaltura entry IDs stay private.
- Query values stay private.
- The popup receives only safe host filename provider format status and timing details.
- Console logs do not include page titles course URLs entry IDs signed URLs or tokens.

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
│   ├── hls.js
│   └── media.js
└── popup/
    ├── popup.css
    ├── popup.html
    └── popup.js
```

## Temporary Firefox installation

1. Open Firefox.
2. Enter `about:debugging`.
3. Select **This Firefox**.
4. Find Canvas HLS Downloader and select **Reload**.
5. If the extension is missing select **Load Temporary Add-on**.
6. Open the project folder and select `manifest.json`.
7. Reload the Canvas page after reloading the extension.

## Phase 4A test

### Single FIU HLS video

1. Open a previously tested FIU video page.
2. Press Play.
3. Confirm one video appears.
4. Analyze it.
5. Confirm HLS quality and MPEG-TS information still work.
6. Download the file and confirm it plays.

### Multiple embedded videos

1. Open a Canvas page containing several embedded players.
2. Press Play on one player at a time.
3. Confirm the video count increases.
4. Confirm each selector item stays separate.
5. Switch between all detected videos.
6. Confirm each selection shows its own source details and analysis state.

### Kaltura detection

Confirm the selected player shows `Kaltura` as the provider and one of these source types:

- HLS
- Direct MP4
- Direct MOV
- MPEG-DASH

HLS can be analyzed. The other source types should show a safe Phase 4B or later message and keep Download disabled.

### Privacy test

Inspect the extension console and confirm it does not show:

- Complete media URLs
- Query strings
- Kaltura entry IDs
- Cookies
- Tokens
- Authorization headers
- Canvas course URLs
- Canvas page titles

## Known Phase 4A limits

- A player must request media before the extension can detect it.
- Player order follows first media request order and may not exactly match page layout order.
- Direct MP4 MOV and MPEG-DASH are detected but not downloaded.
- Output format selection is not included yet.
- MP4 remuxing is not included yet.
- The approved `mux.js` dependency is not added until Phase 4B.
- Only one active download is allowed per Canvas tab.
- Existing MPEG-TS restrictions from Phase 3 still apply.
- Closing the Canvas tab cancels its active download and clears private state.
