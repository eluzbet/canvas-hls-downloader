const CANVAS_ORIGIN = "https://fiu.instructure.com";
const STATE_KEY_PREFIX = "canvas-tab-state:";
const MAX_STREAMS_PER_TAB = 20;

function stateKey(tabId) {
  return `${STATE_KEY_PREFIX}${tabId}`;
}

function isCanvasUrl(rawUrl) {
  try {
    const url = new URL(rawUrl);
    return url.origin === CANVAS_ORIGIN;
  } catch {
    return false;
  }
}

function isHlsPlaylistUrl(rawUrl) {
  try {
    const url = new URL(rawUrl);
    return /\.m3u8$/i.test(url.pathname);
  } catch {
    return false;
  }
}

function summarizeStreamUrl(rawUrl) {
  const url = new URL(rawUrl);
  const pathParts = url.pathname.split("/").filter(Boolean);
  const fileName = pathParts.at(-1) || "playlist.m3u8";

  return {
    host: url.hostname,
    fileName,
    queryParameterCount: [...url.searchParams.keys()].length,
    safeLabel: `${fileName} on ${url.hostname}`
  };
}

function safeLog(message, details = {}) {
  console.info(`[Canvas HLS Downloader] ${message}`, details);
}

async function loadTabState(tabId) {
  const key = stateKey(tabId);
  const result = await browser.storage.session.get(key);

  return result[key] || {
    tabId,
    isCanvasPage: false,
    pageTitle: "",
    streams: [],
    updatedAt: null
  };
}

async function saveTabState(tabId, state) {
  await browser.storage.session.set({
    [stateKey(tabId)]: state
  });
}

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
      : null
  };
}

async function notifyStateUpdated(tabId) {
  try {
    await browser.runtime.sendMessage({
      type: "TAB_STATE_UPDATED",
      tabId
    });
  } catch {
    // No popup is open. This is expected during normal browsing.
  }
}

async function registerCanvasPage(tabId, pageTitle) {
  const state = await loadTabState(tabId);
  state.isCanvasPage = true;
  state.pageTitle = typeof pageTitle === "string" ? pageTitle.trim() : "";
  state.updatedAt = new Date().toISOString();

  await saveTabState(tabId, state);
  await notifyStateUpdated(tabId);

  safeLog("Canvas page registered", {
    tabId,
    titleLength: state.pageTitle.length
  });
}

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
    return state;
  } catch {
    return null;
  }
}

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

  if (duplicateIndex >= 0) {
    state.streams.splice(duplicateIndex, 1);
  }

  state.streams.push(stream);
  state.streams = state.streams.slice(-MAX_STREAMS_PER_TAB);
  state.updatedAt = stream.detectedAt;

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

browser.webRequest.onCompleted.addListener(
  (details) => {
    void captureCompletedPlaylist(details);
  },
  {
    urls: ["<all_urls>"]
  }
);

browser.runtime.onMessage.addListener((message, sender) => {
  if (message?.type === "CANVAS_PAGE_READY" && sender.tab?.id != null) {
    return registerCanvasPage(sender.tab.id, message.pageTitle).then(() => ({
      ok: true
    }));
  }

  if (message?.type === "GET_TAB_STATE" && Number.isInteger(message.tabId)) {
    return loadTabState(message.tabId).then(publicTabState);
  }

  return undefined;
});

browser.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status === "loading") {
    void browser.storage.session.remove(stateKey(tabId));
  }
});

browser.tabs.onRemoved.addListener((tabId) => {
  void browser.storage.session.remove(stateKey(tabId));
});
