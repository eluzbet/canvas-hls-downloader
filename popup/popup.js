const CANVAS_ORIGIN = "https://fiu.instructure.com";
const STREAM_ORIGINS = ["<all_urls>"];

const pageStatus = document.querySelector("#page-status");
const pageTitle = document.querySelector("#page-title");
const streamLabel = document.querySelector("#stream-label");
const detectedTime = document.querySelector("#detected-time");
const permissionButton = document.querySelector("#permission-button");
const downloadButton = document.querySelector("#download-button");
const helpText = document.querySelector("#help-text");

let activeTabId = null;

function isCanvasUrl(rawUrl) {
  try {
    return new URL(rawUrl).origin === CANVAS_ORIGIN;
  } catch {
    return false;
  }
}

function formatDetectedTime(isoDate) {
  if (!isoDate) {
    return "Not available";
  }

  const date = new Date(isoDate);

  if (Number.isNaN(date.getTime())) {
    return "Not available";
  }

  return date.toLocaleTimeString([], {
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit"
  });
}

async function hasStreamHostPermission() {
  return browser.permissions.contains({
    origins: STREAM_ORIGINS
  });
}

function renderState(state, streamPermissionGranted) {
  const isCanvasPage = Boolean(state?.isCanvasPage);
  const hasStream = Boolean(state?.streamDetected && state.stream);

  pageTitle.textContent = state?.pageTitle || "Not detected";
  streamLabel.textContent = hasStream
    ? state.stream.safeLabel
    : "Not detected";
  detectedTime.textContent = hasStream
    ? formatDetectedTime(state.stream.detectedAt)
    : "Not available";

  permissionButton.hidden = streamPermissionGranted;
  downloadButton.disabled = !hasStream;

  if (!isCanvasPage) {
    pageStatus.textContent = "This is not an FIU Canvas page.";
    helpText.textContent = "Open a page on fiu.instructure.com.";
    return;
  }

  if (!streamPermissionGranted) {
    pageStatus.textContent = "FIU Canvas page detected.";
    helpText.textContent =
      "Enable stream detection, then reload the page and play the video.";
    return;
  }

  if (!hasStream) {
    pageStatus.textContent = "FIU Canvas page detected. Waiting for HLS.";
    helpText.textContent =
      "Reload the video page and press Play so Firefox requests the playlist.";
    return;
  }

  pageStatus.textContent = "Successful HLS playlist detected.";
  helpText.textContent =
    "Phase 1 stops here. Segment downloading is not implemented yet.";
}

async function refreshPopup() {
  const [tab] = await browser.tabs.query({
    active: true,
    currentWindow: true
  });

  if (!tab?.id) {
    renderState(null, await hasStreamHostPermission());
    return;
  }

  activeTabId = tab.id;
  const streamPermissionGranted = await hasStreamHostPermission();
  let state = await browser.runtime.sendMessage({
    type: "GET_TAB_STATE",
    tabId: activeTabId
  });

  if (!state?.isCanvasPage && isCanvasUrl(tab.url)) {
    state = {
      ...state,
      isCanvasPage: true,
      pageTitle: tab.title || state?.pageTitle || ""
    };
  }

  renderState(state, streamPermissionGranted);
}

permissionButton.addEventListener("click", async () => {
  permissionButton.disabled = true;

  const granted = await browser.permissions.request({
    origins: STREAM_ORIGINS
  });

  permissionButton.disabled = false;

  if (!granted) {
    helpText.textContent =
      "Stream detection permission was not granted. No network requests are being read.";
    return;
  }

  await refreshPopup();
  helpText.textContent =
    "Permission granted. Reload the Canvas video page and press Play.";
});

downloadButton.addEventListener("click", () => {
  helpText.textContent =
    "The stream is ready for the next phase. Downloading is intentionally disabled in Phase 1.";
});

browser.runtime.onMessage.addListener((message) => {
  if (message?.type === "TAB_STATE_UPDATED" && message.tabId === activeTabId) {
    void refreshPopup();
  }
});

void refreshPopup();
