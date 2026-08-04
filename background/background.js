const CANVAS_ORIGIN = "https://fiu.instructure.com";
const STATE_KEY_PREFIX = "canvas-tab-state:";
const TEMP_FILE_PREFIX = "canvas-hls-temp-";
const MAX_STREAMS_PER_TAB = 20;
const MAX_PLAYLIST_BYTES = 5 * 1024 * 1024;
const SEGMENT_RETRY_COUNT = 3;
const SEGMENT_RETRY_DELAY_MS = 750;
const PROGRESS_UPDATE_INTERVAL_MS = 250;
const activeDownloads = new Map();

// makes the session storage key for one tab
function stateKey(tabId) {
  return `${STATE_KEY_PREFIX}${tabId}`;
}

// makes a new analysis state
function createAnalysisState(status = "idle") {
  return {
    status,
    playlistType: null,
    variantCount: 0,
    availableQualities: [],
    selectedQuality: null,
    selectedStream: null,
    media: null,
    warning: null,
    error: null,
    analyzedAt: null
  };
}

// makes a new download state
function createDownloadState(status = "idle") {
  return {
    status,
    filename: null,
    progressPercent: 0,
    completedSegments: 0,
    totalSegments: 0,
    downloadedBytes: 0,
    speedBytesPerSecond: 0,
    tempFileName: null,
    browserDownloadId: null,
    error: null,
    startedAt: null,
    finishedAt: null
  };
}

// makes a clean starting state for one tab
function createTabState(tabId) {
  return {
    tabId,
    isCanvasPage: false,
    pageTitle: "",
    pageUrl: "",
    streams: [],
    analysis: createAnalysisState(),
    download: createDownloadState(),
    updatedAt: null
  };
}

// checks if a url belongs to fiu canvas
function isCanvasUrl(rawUrl) {
  try {
    const url = new URL(rawUrl);
    return url.origin === CANVAS_ORIGIN;
  } catch {
    return false;
  }
}

// checks if a url ends with m3u8
function isHlsPlaylistUrl(rawUrl) {
  try {
    const url = new URL(rawUrl);
    return /\.m3u8$/i.test(url.pathname);
  } catch {
    return false;
  }
}

// makes a safe stream summary without query values
function summarizeStreamUrl(rawUrl) {
  const url = new URL(rawUrl);
  const summary = HlsParser.summarizeUrl(rawUrl);

  return {
    ...summary,
    queryParameterCount: [...url.searchParams.keys()].length
  };
}

// writes logs that do not include signed urls
function safeLog(message, details = {}) {
  console.info(`[Canvas HLS Downloader] ${message}`, details);
}

// waits before another retry
function delay(milliseconds) {
  return new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}

// loads one tab state from memory only storage
async function loadTabState(tabId) {
  const key = stateKey(tabId);
  const result = await browser.storage.session.get(key);
  const state = result[key] || createTabState(tabId);

  if (!state.analysis) {
    state.analysis = createAnalysisState();
  }

  if (!state.download) {
    state.download = createDownloadState();
  }

  return state;
}

// saves one tab state to memory only storage
async function saveTabState(tabId, state) {
  await browser.storage.session.set({
    [stateKey(tabId)]: state
  });
}

// removes private analysis values before popup messages
function publicAnalysisState(analysis) {
  if (!analysis) {
    return createAnalysisState();
  }

  const { selectedPlaylistUrl, ...safeAnalysis } = analysis;
  return safeAnalysis;
}

// removes private download values before popup messages
function publicDownloadState(download) {
  if (!download) {
    return createDownloadState();
  }

  const { tempFileName, browserDownloadId, ...safeDownload } = download;
  return safeDownload;
}

// removes private urls before sending state to the popup
function publicTabState(state) {
  const latestStream = state.streams.at(-1) || null;

  return {
    tabId: state.tabId,
    isCanvasPage: state.isCanvasPage,
    pageTitle: state.pageTitle,
    streamDetected: Boolean(latestStream),
    stream: latestStream
      ? {
          host: latestStream.host,
          fileName: latestStream.fileName,
          safeLabel: latestStream.safeLabel,
          statusCode: latestStream.statusCode,
          requestType: latestStream.requestType,
          detectedAt: latestStream.detectedAt
        }
      : null,
    analysis: publicAnalysisState(state.analysis),
    download: publicDownloadState(state.download)
  };
}

// tells an open popup that tab state changed
async function notifyStateUpdated(tabId) {
  try {
    await browser.runtime.sendMessage({
      type: "TAB_STATE_UPDATED",
      tabId
    });
  } catch {
    // no popup is open
  }
}

// stores page details for one canvas tab
async function registerCanvasPage(tabId, pageTitle, pageUrl) {
  const state = await loadTabState(tabId);
  state.isCanvasPage = true;
  state.pageTitle = typeof pageTitle === "string" ? pageTitle.trim() : "";
  state.pageUrl = isCanvasUrl(pageUrl) ? pageUrl : state.pageUrl;
  state.updatedAt = new Date().toISOString();

  await saveTabState(tabId, state);
  await notifyStateUpdated(tabId);

  safeLog("Canvas page registered", {
    tabId,
    titleLength: state.pageTitle.length
  });
}

// confirms the request came from a canvas tab
async function confirmCanvasTab(tabId) {
  const state = await loadTabState(tabId);

  if (state.isCanvasPage) {
    return state;
  }

  try {
    const tab = await browser.tabs.get(tabId);

    if (!isCanvasUrl(tab.url)) {
      return null;
    }

    state.isCanvasPage = true;
    state.pageTitle = typeof tab.title === "string" ? tab.title.trim() : "";
    state.pageUrl = tab.url;
    return state;
  } catch {
    return null;
  }
}

// makes a safe readable quality label
function makeQualityLabel(item) {
  if (item?.width && item?.height) {
    return `${item.width} × ${item.height}`;
  }

  if (item?.height) {
    return `${item.height}p`;
  }

  const bandwidth = item?.bandwidth || item?.averageBandwidth;

  if (bandwidth) {
    return `${(bandwidth / 1000000).toFixed(2)} Mbps`;
  }

  return "unknown";
}

// guesses a height from names like 480 m3u8
function inferHeightFromFileName(fileName) {
  const match = String(fileName).match(/(?:^|[^0-9])(\d{3,4})p?(?:[^0-9]|$)/i);

  if (!match) {
    return null;
  }

  const height = Number(match[1]);
  return height >= 144 && height <= 4320 ? height : null;
}

// fetches playlist text from the background extension context
async function fetchPlaylistText(rawUrl) {
  let response;

  try {
    response = await fetch(rawUrl, {
      method: "GET",
      credentials: "include",
      cache: "no-store",
      redirect: "follow",
      headers: {
        Accept:
          "application/vnd.apple.mpegurl, application/x-mpegURL, text/plain, */*"
      }
    });
  } catch {
    throw {
      code: "PLAYLIST_FETCH_FAILED",
      message: "Firefox could not fetch the playlist again"
    };
  }

  if (!response.ok) {
    throw {
      code: `PLAYLIST_HTTP_${response.status}`,
      message: `Playlist request returned HTTP ${response.status}`
    };
  }

  const declaredLength = Number(response.headers.get("content-length"));

  if (Number.isFinite(declaredLength) && declaredLength > MAX_PLAYLIST_BYTES) {
    throw {
      code: "PLAYLIST_TOO_LARGE",
      message: "Playlist is larger than the safety limit"
    };
  }

  const text = await response.text();

  if (new TextEncoder().encode(text).byteLength > MAX_PLAYLIST_BYTES) {
    throw {
      code: "PLAYLIST_TOO_LARGE",
      message: "Playlist is larger than the safety limit"
    };
  }

  return text;
}

// matches a master variant to a signed url already seen by firefox
function findCapturedVariantUrl(variantUrl, streams) {
  try {
    const target = new URL(variantUrl);
    const match = streams.find((stream) => {
      const seen = new URL(stream.url);
      return seen.hostname === target.hostname && seen.pathname === target.pathname;
    });

    return match?.url || variantUrl;
  } catch {
    return variantUrl;
  }
}

// keeps only media details needed by the popup and download checks
function summarizeMediaPlaylist(media) {
  return {
    segmentCount: media.segmentCount,
    totalDuration: media.totalDuration,
    targetDuration: media.targetDuration,
    hasEndList: media.hasEndList,
    hasInitSegment: Boolean(media.initSegment),
    hasDiscontinuity: media.hasDiscontinuity,
    byteRangeCount: media.byteRangeCount,
    container: media.container,
    isEncrypted: media.isEncrypted,
    encryptionMethods: media.encryptionMethods
  };
}

// makes safe variant details for the popup
function summarizeVariant(variant) {
  return {
    host: variant.host,
    fileName: variant.fileName,
    safeLabel: variant.safeLabel,
    width: variant.width,
    height: variant.height,
    bandwidth: variant.bandwidth,
    averageBandwidth: variant.averageBandwidth,
    frameRate: variant.frameRate,
    codecs: variant.codecs,
    audioGroup: variant.audioGroup,
    subtitlesGroup: variant.subtitlesGroup,
    qualityLabel: makeQualityLabel(variant)
  };
}

// gives likely master playlists first during analysis
function sortPlaylistCandidates(streams) {
  const masterNamePattern = /(master|video|index|playlist)\.m3u8$/i;

  return [...streams].sort((left, right) => {
    const leftMasterScore = masterNamePattern.test(left.fileName) ? 1 : 0;
    const rightMasterScore = masterNamePattern.test(right.fileName) ? 1 : 0;

    if (rightMasterScore !== leftMasterScore) {
      return rightMasterScore - leftMasterScore;
    }

    return new Date(right.detectedAt).getTime() - new Date(left.detectedAt).getTime();
  });
}

// picks the best observed media playlist when no master is found
function selectBestMediaCandidate(candidates) {
  return [...candidates].sort((left, right) => {
    const leftHeight = inferHeightFromFileName(left.stream.fileName) || 0;
    const rightHeight = inferHeightFromFileName(right.stream.fileName) || 0;

    if (rightHeight !== leftHeight) {
      return rightHeight - leftHeight;
    }

    return right.parsed.segmentCount - left.parsed.segmentCount;
  })[0];
}

// analyzes a master playlist and its highest quality variant
async function analyzeMasterPlaylist(master, streams) {
  const bestVariant = HlsParser.selectBestVariant(master.variants);
  const safeVariants = master.variants.map(summarizeVariant);
  const availableQualities = [
    ...new Set(safeVariants.map((variant) => variant.qualityLabel))
  ];

  if (!bestVariant) {
    return {
      status: "partial",
      playlistType: "master",
      variantCount: 0,
      availableQualities,
      selectedQuality: null,
      selectedStream: null,
      media: null,
      warning: "Master playlist had no playable variants",
      error: null,
      analyzedAt: new Date().toISOString()
    };
  }

  const selectedVariant = summarizeVariant(bestVariant);
  const selectedUrl = findCapturedVariantUrl(bestVariant.url, streams);

  try {
    const mediaText = await fetchPlaylistText(selectedUrl);
    const media = HlsParser.parsePlaylist(mediaText, selectedUrl);

    if (media.type !== "media") {
      throw {
        code: "SELECTED_VARIANT_NOT_MEDIA",
        message: "Selected variant was not a media playlist"
      };
    }

    return {
      status: "ready",
      playlistType: "master",
      variantCount: master.variants.length,
      availableQualities,
      selectedQuality: selectedVariant.qualityLabel,
      selectedStream: selectedVariant,
      media: summarizeMediaPlaylist(media),
      warning: null,
      error: null,
      analyzedAt: new Date().toISOString(),
      selectedPlaylistUrl: selectedUrl
    };
  } catch {
    return {
      status: "partial",
      playlistType: "master",
      variantCount: master.variants.length,
      availableQualities,
      selectedQuality: selectedVariant.qualityLabel,
      selectedStream: selectedVariant,
      media: null,
      warning: "Highest quality was found but its media playlist could not be read",
      error: null,
      analyzedAt: new Date().toISOString(),
      selectedPlaylistUrl: selectedUrl
    };
  }
}

// analyzes all captured playlists for one tab
async function buildPlaylistAnalysis(streams) {
  const mediaCandidates = [];
  let firstSafeError = null;

  for (const stream of sortPlaylistCandidates(streams)) {
    try {
      const text = await fetchPlaylistText(stream.url);
      const parsed = HlsParser.parsePlaylist(text, stream.url);

      if (parsed.type === "master") {
        return analyzeMasterPlaylist(parsed, streams);
      }

      if (parsed.type === "media") {
        mediaCandidates.push({
          stream,
          parsed
        });
      }
    } catch (error) {
      if (!firstSafeError) {
        firstSafeError = normalizeAnalysisError(error);
      }
    }
  }

  if (mediaCandidates.length > 0) {
    const selected = selectBestMediaCandidate(mediaCandidates);
    const inferredHeight = inferHeightFromFileName(selected.stream.fileName);

    return {
      status: "ready",
      playlistType: "media",
      variantCount: 0,
      availableQualities: inferredHeight ? [`${inferredHeight}p`] : [],
      selectedQuality: inferredHeight ? `${inferredHeight}p` : "unknown",
      selectedStream: {
        host: selected.stream.host,
        fileName: selected.stream.fileName,
        safeLabel: selected.stream.safeLabel,
        width: null,
        height: inferredHeight,
        bandwidth: null,
        averageBandwidth: null,
        frameRate: null,
        codecs: "",
        audioGroup: "",
        subtitlesGroup: "",
        qualityLabel: inferredHeight ? `${inferredHeight}p` : "unknown"
      },
      media: summarizeMediaPlaylist(selected.parsed),
      warning: "No master playlist was available so quality came from observed media playlists",
      error: null,
      analyzedAt: new Date().toISOString(),
      selectedPlaylistUrl: selected.stream.url
    };
  }

  throw (
    firstSafeError || {
      code: "NO_PARSEABLE_PLAYLIST",
      message: "No captured playlist could be parsed"
    }
  );
}

// changes unknown analysis errors into safe popup messages
function normalizeAnalysisError(error) {
  const safeCodes = new Set([
    "PLAYLIST_FETCH_FAILED",
    "PLAYLIST_TOO_LARGE",
    "NO_PARSEABLE_PLAYLIST",
    "SELECTED_VARIANT_NOT_MEDIA"
  ]);

  if (
    error &&
    typeof error.code === "string" &&
    (safeCodes.has(error.code) || error.code.startsWith("PLAYLIST_HTTP_"))
  ) {
    return {
      code: error.code,
      message: String(error.message || "Playlist analysis failed")
    };
  }

  if (error instanceof Error && error.message === "INVALID_HLS_PLAYLIST") {
    return {
      code: "INVALID_HLS_PLAYLIST",
      message: "The response was not a valid HLS playlist"
    };
  }

  return {
    code: "PLAYLIST_ANALYSIS_FAILED",
    message: "Playlist analysis failed"
  };
}

// runs playlist analysis and stores safe results plus one private selected url
async function analyzeTabPlaylists(tabId) {
  const state = await loadTabState(tabId);

  if (!state.isCanvasPage || state.streams.length === 0) {
    return publicTabState(state);
  }

  if (isDownloadActive(state.download.status)) {
    return publicTabState(state);
  }

  state.analysis = createAnalysisState("loading");
  state.updatedAt = new Date().toISOString();
  await saveTabState(tabId, state);
  await notifyStateUpdated(tabId);

  try {
    const analysis = await buildPlaylistAnalysis(state.streams);
    const latestState = await loadTabState(tabId);
    latestState.analysis = analysis;
    latestState.updatedAt = analysis.analyzedAt;

    await saveTabState(tabId, latestState);
    await notifyStateUpdated(tabId);

    safeLog("HLS playlist analysis finished", {
      tabId,
      status: analysis.status,
      playlistType: analysis.playlistType,
      variantCount: analysis.variantCount,
      selectedQuality: analysis.selectedQuality,
      segmentCount: analysis.media?.segmentCount || 0,
      container: analysis.media?.container || "unknown"
    });

    return publicTabState(latestState);
  } catch (error) {
    const safeError = normalizeAnalysisError(error);
    const latestState = await loadTabState(tabId);
    latestState.analysis = {
      ...createAnalysisState("error"),
      error: safeError,
      analyzedAt: new Date().toISOString()
    };
    latestState.updatedAt = latestState.analysis.analyzedAt;

    await saveTabState(tabId, latestState);
    await notifyStateUpdated(tabId);

    safeLog("HLS playlist analysis failed", {
      tabId,
      code: safeError.code
    });

    return publicTabState(latestState);
  }
}

// checks if a download is currently doing work
function isDownloadActive(status) {
  return ["preparing", "downloading", "saving", "canceling"].includes(status);
}

// checks if phase 3 can download the analyzed stream
function getDownloadBlockReason(state) {
  const analysis = state.analysis;

  if (analysis?.status !== "ready" || !analysis.selectedPlaylistUrl) {
    return "Analyze the playlist before downloading";
  }

  if (!analysis.media) {
    return "The selected media playlist is not available";
  }

  if (analysis.media.container !== "MPEG-TS") {
    return "Phase 3 only downloads MPEG TS streams";
  }

  if (analysis.media.isEncrypted) {
    return "Encrypted HLS streams are not supported in Phase 3";
  }

  if (analysis.media.hasInitSegment) {
    return "Initialization segments are handled in a later phase";
  }

  if (!analysis.media.hasEndList) {
    return "Live HLS playlists are not supported in Phase 3";
  }

  if (analysis.media.hasDiscontinuity) {
    return "Playlists with discontinuities are not supported in Phase 3";
  }

  if (analysis.selectedStream?.audioGroup) {
    return "Separate audio groups are not supported in Phase 3";
  }

  return null;
}

// cleans a page title for a local video filename
function makeDownloadFilename(pageTitle, selectedQuality) {
  let cleanTitle = String(pageTitle || "Canvas video")
    .normalize("NFKC")
    .replace(/^Video:\s*/i, "")
    .replace(/[<>:"/\\|?*\u0000-\u001F]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[. ]+$/g, "");

  if (!cleanTitle) {
    cleanTitle = "Canvas video";
  }

  const quality = String(selectedQuality || "")
    .replace(/\s*×\s*/g, "x")
    .replace(/[^0-9A-Za-z.-]+/g, "")
    .trim();
  const suffix = quality ? ` - ${quality}` : "";
  const maximumBaseLength = Math.max(20, 180 - suffix.length - 3);
  const baseName = cleanTitle.slice(0, maximumBaseLength).trim();

  return `${baseName}${suffix}.ts`;
}

// parses an hls byte range value
function parseByteRange(value) {
  const match = String(value || "").match(/^(\d+)(?:@(\d+))?$/);

  if (!match) {
    throw {
      code: "INVALID_BYTE_RANGE",
      message: "The media playlist has an invalid byte range"
    };
  }

  return {
    length: Number(match[1]),
    offset: match[2] == null ? null : Number(match[2])
  };
}

// calculates request ranges for every segment
function prepareSegmentsForDownload(segments) {
  const nextOffsets = new Map();

  return segments.map((segment) => {
    if (!segment.byteRange) {
      return {
        ...segment,
        rangeStart: null,
        rangeEnd: null
      };
    }

    const parsedRange = parseByteRange(segment.byteRange);
    const rangeStart =
      parsedRange.offset == null
        ? nextOffsets.get(segment.url) || 0
        : parsedRange.offset;
    const rangeEnd = rangeStart + parsedRange.length - 1;
    nextOffsets.set(segment.url, rangeEnd + 1);

    return {
      ...segment,
      rangeStart,
      rangeEnd
    };
  });
}

// estimates the output size from the selected bandwidth
function estimateOutputBytes(analysis) {
  const bandwidth =
    analysis.selectedStream?.averageBandwidth ||
    analysis.selectedStream?.bandwidth ||
    0;
  const duration = analysis.media?.totalDuration || 0;

  if (!bandwidth || !duration) {
    return null;
  }

  return Math.ceil((bandwidth * duration) / 8);
}

// checks if opfs has enough estimated free space
async function checkStorageSpace(estimatedBytes) {
  if (!estimatedBytes || !navigator.storage?.estimate) {
    return;
  }

  const estimate = await navigator.storage.estimate();
  const quota = Number(estimate.quota || 0);
  const usage = Number(estimate.usage || 0);
  const freeBytes = Math.max(0, quota - usage);
  const requestedBytes = Math.ceil(estimatedBytes * 1.25);

  if (freeBytes > 0 && requestedBytes > freeBytes) {
    throw {
      code: "NOT_ENOUGH_STORAGE",
      message: "Firefox does not report enough temporary storage for this video"
    };
  }
}

// opens one temporary file inside firefox private storage
async function createTemporaryFile() {
  if (!navigator.storage?.getDirectory) {
    throw {
      code: "OPFS_UNAVAILABLE",
      message: "Firefox temporary file storage is not available"
    };
  }

  const root = await navigator.storage.getDirectory();
  const tempFileName = `${TEMP_FILE_PREFIX}${crypto.randomUUID()}.part`;
  const fileHandle = await root.getFileHandle(tempFileName, {
    create: true
  });
  const writable = await fileHandle.createWritable();

  return {
    root,
    tempFileName,
    fileHandle,
    writable
  };
}

// fetches one segment and keeps the full url private
async function fetchSegment(segment, controller, segmentNumber) {
  const headers = {
    Accept: "video/mp2t, application/octet-stream, */*"
  };

  if (segment.rangeStart != null && segment.rangeEnd != null) {
    headers.Range = `bytes=${segment.rangeStart}-${segment.rangeEnd}`;
  }

  let response;

  try {
    response = await fetch(segment.url, {
      method: "GET",
      credentials: "include",
      cache: "no-store",
      redirect: "follow",
      headers,
      signal: controller.signal
    });
  } catch (error) {
    if (error?.name === "AbortError") {
      throw error;
    }

    throw {
      code: "SEGMENT_FETCH_FAILED",
      message: `Segment ${segmentNumber} could not be downloaded`
    };
  }

  const expectedStatus = segment.rangeStart == null ? 200 : 206;

  if (!response.ok || response.status !== expectedStatus) {
    throw {
      code: `SEGMENT_HTTP_${response.status}`,
      message: `Segment ${segmentNumber} returned HTTP ${response.status}`
    };
  }

  return response.arrayBuffer();
}

// retries one failed segment a few times
async function fetchSegmentWithRetry(job, segment, segmentNumber) {
  let lastError = null;

  for (let attempt = 1; attempt <= SEGMENT_RETRY_COUNT; attempt += 1) {
    if (job.canceled) {
      throw {
        code: "DOWNLOAD_CANCELED",
        message: "Download canceled"
      };
    }

    job.controller = new AbortController();

    try {
      return await fetchSegment(segment, job.controller, segmentNumber);
    } catch (error) {
      if (job.canceled || error?.name === "AbortError") {
        throw {
          code: "DOWNLOAD_CANCELED",
          message: "Download canceled"
        };
      }

      lastError = error;

      if (attempt < SEGMENT_RETRY_COUNT) {
        await delay(SEGMENT_RETRY_DELAY_MS * attempt);
      }
    }
  }

  throw lastError || {
    code: "SEGMENT_FETCH_FAILED",
    message: `Segment ${segmentNumber} could not be downloaded`
  };
}

// writes current progress into memory only storage
async function saveDownloadProgress(tabId, job, force = false) {
  const now = Date.now();

  if (
    !force &&
    now - job.lastProgressUpdateAt < PROGRESS_UPDATE_INTERVAL_MS &&
    job.completedSegments < job.totalSegments
  ) {
    return;
  }

  job.lastProgressUpdateAt = now;
  const state = await loadTabState(tabId);
  const elapsedSeconds = Math.max(0.001, (now - job.startedAtMs) / 1000);
  const progressPercent =
    job.totalSegments > 0
      ? Math.min(100, (job.completedSegments / job.totalSegments) * 100)
      : 0;

  state.download = {
    ...state.download,
    status: "downloading",
    filename: job.filename,
    progressPercent,
    completedSegments: job.completedSegments,
    totalSegments: job.totalSegments,
    downloadedBytes: job.downloadedBytes,
    speedBytesPerSecond: job.downloadedBytes / elapsedSeconds,
    tempFileName: job.tempFileName,
    startedAt: job.startedAt,
    error: null
  };
  state.updatedAt = new Date().toISOString();

  await saveTabState(tabId, state);
  await notifyStateUpdated(tabId);
}

// waits for firefox to finish saving the staged file
function waitForBrowserDownload(downloadId, job) {
  return new Promise((resolve, reject) => {
    let settled = false;

    // removes the listener and finishes one result
    function finish(callback, value) {
      if (settled) {
        return;
      }

      settled = true;
      browser.downloads.onChanged.removeListener(listener);
      callback(value);
    }

    // handles browser download state changes
    function listener(delta) {
      if (delta.id !== downloadId || !delta.state?.current) {
        return;
      }

      if (delta.state.current === "complete") {
        finish(resolve);
        return;
      }

      if (delta.state.current === "interrupted") {
        finish(reject, {
          code: job.canceled
            ? "DOWNLOAD_CANCELED"
            : "BROWSER_DOWNLOAD_INTERRUPTED",
          message: job.canceled
            ? "Download canceled"
            : "Firefox could not finish saving the video"
        });
      }
    }

    browser.downloads.onChanged.addListener(listener);

    void browser.downloads.search({ id: downloadId }).then((items) => {
      const item = items[0];

      if (!item || settled) {
        return;
      }

      if (item.state === "complete") {
        finish(resolve);
      } else if (item.state === "interrupted") {
        finish(reject, {
          code: job.canceled
            ? "DOWNLOAD_CANCELED"
            : "BROWSER_DOWNLOAD_INTERRUPTED",
          message: job.canceled
            ? "Download canceled"
            : "Firefox could not finish saving the video"
        });
      }
    });
  });
}

// removes a temporary opfs file when it is no longer needed
async function removeTemporaryFile(tempFileName) {
  if (!tempFileName || !navigator.storage?.getDirectory) {
    return;
  }

  try {
    const root = await navigator.storage.getDirectory();
    await root.removeEntry(tempFileName);
  } catch {
    // file may already be gone
  }
}

// changes unknown download errors into safe popup messages
function normalizeDownloadError(error) {
  const safeCodes = new Set([
    "DOWNLOAD_CANCELED",
    "OPFS_UNAVAILABLE",
    "NOT_ENOUGH_STORAGE",
    "INVALID_BYTE_RANGE",
    "SEGMENT_FETCH_FAILED",
    "BROWSER_DOWNLOAD_INTERRUPTED",
    "BROWSER_SAVE_FAILED",
    "UNSUPPORTED_MEDIA_PLAYLIST",
    "UNSUPPORTED_CONTAINER",
    "UNSUPPORTED_ENCRYPTION",
    "UNSUPPORTED_LIVE_PLAYLIST",
    "UNSUPPORTED_DISCONTINUITY",
    "UNSUPPORTED_SEPARATE_AUDIO",
    "NO_MEDIA_SEGMENTS"
  ]);

  if (
    error &&
    typeof error.code === "string" &&
    (safeCodes.has(error.code) ||
      error.code.startsWith("SEGMENT_HTTP_") ||
      error.code.startsWith("PLAYLIST_HTTP_"))
  ) {
    return {
      code: error.code,
      message: String(error.message || "Video download failed")
    };
  }

  if (error?.name === "QuotaExceededError") {
    return {
      code: "NOT_ENOUGH_STORAGE",
      message: "Firefox ran out of temporary storage while downloading"
    };
  }

  return {
    code: "VIDEO_DOWNLOAD_FAILED",
    message: "Video download failed"
  };
}

// validates the fresh media playlist before downloading
function validateDownloadMedia(state, media) {
  if (media.type !== "media") {
    throw {
      code: "UNSUPPORTED_MEDIA_PLAYLIST",
      message: "The selected stream is not a media playlist"
    };
  }

  if (media.container !== "MPEG-TS") {
    throw {
      code: "UNSUPPORTED_CONTAINER",
      message: "Phase 3 only downloads MPEG TS streams"
    };
  }

  if (media.isEncrypted) {
    throw {
      code: "UNSUPPORTED_ENCRYPTION",
      message: "Encrypted HLS streams are not supported in Phase 3"
    };
  }

  if (!media.hasEndList) {
    throw {
      code: "UNSUPPORTED_LIVE_PLAYLIST",
      message: "Live HLS playlists are not supported in Phase 3"
    };
  }

  if (media.hasDiscontinuity) {
    throw {
      code: "UNSUPPORTED_DISCONTINUITY",
      message: "Playlists with discontinuities are not supported in Phase 3"
    };
  }

  if (state.analysis.selectedStream?.audioGroup) {
    throw {
      code: "UNSUPPORTED_SEPARATE_AUDIO",
      message: "Separate audio groups are not supported in Phase 3"
    };
  }

  if (!media.segments.length) {
    throw {
      code: "NO_MEDIA_SEGMENTS",
      message: "The media playlist does not contain segments"
    };
  }
}

// updates final state after a successful browser save
async function finishDownload(tabId, job) {
  const state = await loadTabState(tabId);
  state.download = {
    ...createDownloadState("complete"),
    filename: job.filename,
    progressPercent: 100,
    completedSegments: job.totalSegments,
    totalSegments: job.totalSegments,
    downloadedBytes: job.downloadedBytes,
    speedBytesPerSecond: 0,
    startedAt: job.startedAt,
    finishedAt: new Date().toISOString()
  };
  state.updatedAt = state.download.finishedAt;

  await saveTabState(tabId, state);
  await notifyStateUpdated(tabId);

  safeLog("MPEG TS download finished", {
    tabId,
    segmentCount: job.totalSegments,
    downloadedBytes: job.downloadedBytes
  });
}

// updates final state after a cancel or failure
async function failDownload(tabId, job, error) {
  const safeError = normalizeDownloadError(error);
  const canceled = safeError.code === "DOWNLOAD_CANCELED";
  const state = await loadTabState(tabId);
  state.download = {
    ...createDownloadState(canceled ? "canceled" : "error"),
    filename: job?.filename || state.download.filename,
    progressPercent: state.download.progressPercent || 0,
    completedSegments: state.download.completedSegments || 0,
    totalSegments: state.download.totalSegments || 0,
    downloadedBytes: state.download.downloadedBytes || 0,
    error: canceled ? null : safeError,
    startedAt: state.download.startedAt,
    finishedAt: new Date().toISOString()
  };
  state.updatedAt = state.download.finishedAt;

  await saveTabState(tabId, state);
  await notifyStateUpdated(tabId);

  safeLog(canceled ? "MPEG TS download canceled" : "MPEG TS download failed", {
    tabId,
    code: safeError.code
  });
}

// downloads segments into opfs then saves one ts file through firefox
async function runMpegTsDownload(tabId) {
  let job = null;
  let writable = null;
  let objectUrl = null;

  try {
    const state = await loadTabState(tabId);
    const blockReason = getDownloadBlockReason(state);

    if (blockReason) {
      throw {
        code: "UNSUPPORTED_MEDIA_PLAYLIST",
        message: blockReason
      };
    }

    const playlistUrl = state.analysis.selectedPlaylistUrl;
    const playlistText = await fetchPlaylistText(playlistUrl);
    const media = HlsParser.parsePlaylist(playlistText, playlistUrl);
    validateDownloadMedia(state, media);

    const segments = prepareSegmentsForDownload(media.segments);
    const filename = makeDownloadFilename(
      state.pageTitle,
      state.analysis.selectedQuality
    );
    const estimatedBytes = estimateOutputBytes(state.analysis);
    await checkStorageSpace(estimatedBytes);

    try {
      await navigator.storage.persist();
    } catch {
      // persistence is optional
    }

    const temporaryFile = await createTemporaryFile();
    writable = temporaryFile.writable;
    job = {
      tabId,
      canceled: false,
      controller: null,
      filename,
      tempFileName: temporaryFile.tempFileName,
      fileHandle: temporaryFile.fileHandle,
      browserDownloadId: null,
      completedSegments: 0,
      totalSegments: segments.length,
      downloadedBytes: 0,
      startedAt: new Date().toISOString(),
      startedAtMs: Date.now(),
      lastProgressUpdateAt: 0
    };
    activeDownloads.set(tabId, job);

    const preparingState = await loadTabState(tabId);
    preparingState.download = {
      ...createDownloadState("downloading"),
      filename,
      totalSegments: segments.length,
      tempFileName: job.tempFileName,
      startedAt: job.startedAt
    };
    preparingState.updatedAt = job.startedAt;
    await saveTabState(tabId, preparingState);
    await notifyStateUpdated(tabId);

    for (let index = 0; index < segments.length; index += 1) {
      if (job.canceled) {
        throw {
          code: "DOWNLOAD_CANCELED",
          message: "Download canceled"
        };
      }

      const buffer = await fetchSegmentWithRetry(
        job,
        segments[index],
        index + 1
      );
      await writable.write(new Uint8Array(buffer));
      job.downloadedBytes += buffer.byteLength;
      job.completedSegments = index + 1;
      await saveDownloadProgress(tabId, job, index + 1 === segments.length);
    }

    await writable.close();
    writable = null;

    if (job.canceled) {
      throw {
        code: "DOWNLOAD_CANCELED",
        message: "Download canceled"
      };
    }

    const savingState = await loadTabState(tabId);
    savingState.download = {
      ...savingState.download,
      status: "saving",
      progressPercent: 100,
      speedBytesPerSecond: 0
    };
    savingState.updatedAt = new Date().toISOString();
    await saveTabState(tabId, savingState);
    await notifyStateUpdated(tabId);

    const file = await job.fileHandle.getFile();
    objectUrl = URL.createObjectURL(file);

    try {
      job.browserDownloadId = await browser.downloads.download({
        url: objectUrl,
        filename: job.filename,
        conflictAction: "uniquify",
        saveAs: false
      });
    } catch {
      throw {
        code: "BROWSER_SAVE_FAILED",
        message: "Firefox could not start saving the video"
      };
    }

    const savingWithIdState = await loadTabState(tabId);
    savingWithIdState.download.browserDownloadId = job.browserDownloadId;
    await saveTabState(tabId, savingWithIdState);

    await waitForBrowserDownload(job.browserDownloadId, job);
    await finishDownload(tabId, job);
  } catch (error) {
    if (writable) {
      try {
        await writable.abort();
      } catch {
        // writable may already be closed
      }
    }

    await failDownload(tabId, job, error);
  } finally {
    if (objectUrl) {
      URL.revokeObjectURL(objectUrl);
    }

    await removeTemporaryFile(job?.tempFileName);
    activeDownloads.delete(tabId);
  }
}

// starts one phase 3 download without exposing playlist urls
async function startDownload(tabId) {
  const state = await loadTabState(tabId);

  if (activeDownloads.has(tabId) || isDownloadActive(state.download.status)) {
    return publicTabState(state);
  }

  const blockReason = getDownloadBlockReason(state);

  if (blockReason) {
    state.download = {
      ...createDownloadState("error"),
      error: {
        code: "DOWNLOAD_NOT_READY",
        message: blockReason
      },
      finishedAt: new Date().toISOString()
    };
    await saveTabState(tabId, state);
    await notifyStateUpdated(tabId);
    return publicTabState(state);
  }

  state.download = {
    ...createDownloadState("preparing"),
    filename: makeDownloadFilename(
      state.pageTitle,
      state.analysis.selectedQuality
    ),
    totalSegments: state.analysis.media?.segmentCount || 0,
    startedAt: new Date().toISOString()
  };
  state.updatedAt = state.download.startedAt;
  await saveTabState(tabId, state);
  await notifyStateUpdated(tabId);

  void runMpegTsDownload(tabId);
  return publicTabState(state);
}

// cancels one active phase 3 download
async function cancelDownload(tabId) {
  const state = await loadTabState(tabId);
  const job = activeDownloads.get(tabId);

  if (!isDownloadActive(state.download.status) && !job) {
    return publicTabState(state);
  }

  state.download.status = "canceling";
  state.updatedAt = new Date().toISOString();
  await saveTabState(tabId, state);
  await notifyStateUpdated(tabId);

  if (job) {
    job.canceled = true;
    job.controller?.abort();

    if (job.browserDownloadId != null) {
      try {
        await browser.downloads.cancel(job.browserDownloadId);
      } catch {
        // browser download may already be complete
      }
    }
  } else {
    await removeTemporaryFile(state.download.tempFileName);
    await failDownload(tabId, null, {
      code: "DOWNLOAD_CANCELED",
      message: "Download canceled"
    });
  }

  return publicTabState(await loadTabState(tabId));
}

// records one completed successful playlist request
async function captureCompletedPlaylist(details) {
  if (
    details.tabId < 0 ||
    details.statusCode !== 200 ||
    !isHlsPlaylistUrl(details.url)
  ) {
    return;
  }

  const state = await confirmCanvasTab(details.tabId);

  if (!state) {
    return;
  }

  const summary = summarizeStreamUrl(details.url);
  const stream = {
    url: details.url,
    host: summary.host,
    fileName: summary.fileName,
    safeLabel: summary.safeLabel,
    statusCode: details.statusCode,
    requestType: details.type,
    detectedAt: new Date().toISOString()
  };

  const duplicateIndex = state.streams.findIndex(
    (item) => item.url === stream.url
  );
  const isNewStream = duplicateIndex < 0;

  if (duplicateIndex >= 0) {
    state.streams.splice(duplicateIndex, 1);
  }

  state.streams.push(stream);
  state.streams = state.streams.slice(-MAX_STREAMS_PER_TAB);
  state.updatedAt = stream.detectedAt;

  if (
    isNewStream &&
    state.analysis.status !== "loading" &&
    !isDownloadActive(state.download.status)
  ) {
    state.analysis = createAnalysisState();
    state.download = createDownloadState();
  }

  await saveTabState(details.tabId, state);
  await notifyStateUpdated(details.tabId);

  safeLog("Successful HLS playlist detected", {
    tabId: details.tabId,
    statusCode: details.statusCode,
    requestType: details.type,
    host: summary.host,
    fileName: summary.fileName,
    queryParameterCount: summary.queryParameterCount
  });
}

// removes old temporary files after a browser restart or extension update
async function cleanupOrphanedTemporaryFiles() {
  if (!navigator.storage?.getDirectory) {
    return;
  }

  try {
    const root = await navigator.storage.getDirectory();

    for await (const [name] of root.entries()) {
      if (name.startsWith(TEMP_FILE_PREFIX)) {
        await root.removeEntry(name);
      }
    }
  } catch {
    // cleanup should not stop the extension
  }
}

// watches completed requests without blocking them
browser.webRequest.onCompleted.addListener(
  (details) => {
    void captureCompletedPlaylist(details);
  },
  {
    urls: ["<all_urls>"]
  }
);

// handles messages from canvas pages and the popup
browser.runtime.onMessage.addListener((message, sender) => {
  if (message?.type === "CANVAS_PAGE_READY" && sender.tab?.id != null) {
    return registerCanvasPage(
      sender.tab.id,
      message.pageTitle,
      sender.tab.url
    ).then(() => ({
      ok: true
    }));
  }

  if (message?.type === "GET_TAB_STATE" && Number.isInteger(message.tabId)) {
    return loadTabState(message.tabId).then(publicTabState);
  }

  if (message?.type === "ANALYZE_TAB" && Number.isInteger(message.tabId)) {
    return analyzeTabPlaylists(message.tabId);
  }

  if (message?.type === "START_DOWNLOAD" && Number.isInteger(message.tabId)) {
    return startDownload(message.tabId);
  }

  if (message?.type === "CANCEL_DOWNLOAD" && Number.isInteger(message.tabId)) {
    return cancelDownload(message.tabId);
  }

  return undefined;
});

// keeps active download state when a canvas tab reloads
browser.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status !== "loading") {
    return;
  }

  void loadTabState(tabId).then((state) => {
    if (!isDownloadActive(state.download.status)) {
      return browser.storage.session.remove(stateKey(tabId));
    }

    return undefined;
  });
});

// cancels private work when its canvas tab closes
browser.tabs.onRemoved.addListener((tabId) => {
  void cancelDownload(tabId).finally(() => {
    void browser.storage.session.remove(stateKey(tabId));
  });
});

// removes old opfs files after firefox starts
browser.runtime.onStartup.addListener(() => {
  void cleanupOrphanedTemporaryFiles();
});

// removes old opfs files after install or update
browser.runtime.onInstalled.addListener(() => {
  void cleanupOrphanedTemporaryFiles();
});
