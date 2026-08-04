const CANVAS_ORIGIN = "https://fiu.instructure.com";
const STATE_KEY_PREFIX = "canvas-tab-state:";
const MAX_STREAMS_PER_TAB = 20;
const MAX_PLAYLIST_BYTES = 5 * 1024 * 1024;

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

// makes a clean starting state for one tab
function createTabState(tabId) {
  return {
    tabId,
    isCanvasPage: false,
    pageTitle: "",
    pageUrl: "",
    streams: [],
    analysis: createAnalysisState(),
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

// loads one tab state from memory only storage
async function loadTabState(tabId) {
  const key = stateKey(tabId);
  const result = await browser.storage.session.get(key);
  const state = result[key] || createTabState(tabId);

  if (!state.analysis) {
    state.analysis = createAnalysisState();
  }

  return state;
}

// saves one tab state to memory only storage
async function saveTabState(tabId, state) {
  await browser.storage.session.set({
    [stateKey(tabId)]: state
  });
}

// removes the private selected playlist url from analysis output
function publicAnalysisState(analysis) {
  if (!analysis) {
    return createAnalysisState();
  }

  const { selectedPlaylistUrl, ...safeAnalysis } = analysis;
  return safeAnalysis;
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
    analysis: publicAnalysisState(state.analysis)
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
      message: "Playlist is larger than the Phase 2 safety limit"
    };
  }

  const text = await response.text();

  if (new TextEncoder().encode(text).byteLength > MAX_PLAYLIST_BYTES) {
    throw {
      code: "PLAYLIST_TOO_LARGE",
      message: "Playlist is larger than the Phase 2 safety limit"
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

// keeps only media details needed by the popup and later phases
function summarizeMediaPlaylist(media) {
  return {
    segmentCount: media.segmentCount,
    totalDuration: media.totalDuration,
    targetDuration: media.targetDuration,
    hasEndList: media.hasEndList,
    hasInitSegment: Boolean(media.initSegment),
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

// changes unknown errors into safe popup messages
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

// runs playlist analysis and stores only safe results plus one private selected url
async function analyzeTabPlaylists(tabId) {
  const state = await loadTabState(tabId);

  if (!state.isCanvasPage || state.streams.length === 0) {
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

  if (isNewStream && state.analysis.status !== "loading") {
    state.analysis = createAnalysisState();
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

  return undefined;
});

// clears private stream state when a tab starts loading
browser.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status === "loading") {
    void browser.storage.session.remove(stateKey(tabId));
  }
});

// clears private stream state when a tab closes
browser.tabs.onRemoved.addListener((tabId) => {
  void browser.storage.session.remove(stateKey(tabId));
});

