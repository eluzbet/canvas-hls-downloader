const CANVAS_ORIGIN = "https://fiu.instructure.com";
const STREAM_ORIGINS = ["<all_urls>"];

const pageStatus = document.querySelector("#page-status");
const pageTitle = document.querySelector("#page-title");
const streamLabel = document.querySelector("#stream-label");
const detectedTime = document.querySelector("#detected-time");
const analysisStatus = document.querySelector("#analysis-status");
const playlistType = document.querySelector("#playlist-type");
const availableQualities = document.querySelector("#available-qualities");
const selectedQuality = document.querySelector("#selected-quality");
const mediaContainer = document.querySelector("#media-container");
const segmentCount = document.querySelector("#segment-count");
const mediaDuration = document.querySelector("#media-duration");
const encryptionStatus = document.querySelector("#encryption-status");
const permissionButton = document.querySelector("#permission-button");
const analyzeButton = document.querySelector("#analyze-button");
const downloadButton = document.querySelector("#download-button");
const helpText = document.querySelector("#help-text");

let activeTabId = null;

// checks if a url belongs to fiu canvas
function isCanvasUrl(rawUrl) {
  try {
    return new URL(rawUrl).origin === CANVAS_ORIGIN;
  } catch {
    return false;
  }
}

// formats a stored time for the popup
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

// formats playlist seconds as hours minutes and seconds
function formatDuration(totalSeconds) {
  if (!Number.isFinite(totalSeconds) || totalSeconds <= 0) {
    return "Not available";
  }

  const roundedSeconds = Math.round(totalSeconds);
  const hours = Math.floor(roundedSeconds / 3600);
  const minutes = Math.floor((roundedSeconds % 3600) / 60);
  const seconds = roundedSeconds % 60;

  if (hours > 0) {
    return `${hours}h ${minutes}m ${seconds}s`;
  }

  return `${minutes}m ${seconds}s`;
}

// checks if stream host access is already granted
async function hasStreamHostPermission() {
  return browser.permissions.contains({
    origins: STREAM_ORIGINS
  });
}

// writes empty analysis values before analysis finishes
function clearAnalysisFields() {
  playlistType.textContent = "Not available";
  availableQualities.textContent = "Not available";
  selectedQuality.textContent = "Not available";
  mediaContainer.textContent = "Not available";
  segmentCount.textContent = "Not available";
  mediaDuration.textContent = "Not available";
  encryptionStatus.textContent = "Not available";
}

// writes playlist analysis details into the popup
function renderAnalysis(analysis) {
  clearAnalysisFields();

  if (!analysis || analysis.status === "idle") {
    analysisStatus.textContent = "Not started";
    return;
  }

  if (analysis.status === "loading") {
    analysisStatus.textContent = "Analyzing playlist";
    return;
  }

  if (analysis.status === "error") {
    analysisStatus.textContent = analysis.error?.message || "Analysis failed";
    return;
  }

  analysisStatus.textContent =
    analysis.status === "partial" ? "Partial result" : "Complete";
  playlistType.textContent = analysis.playlistType || "Not available";
  availableQualities.textContent = analysis.availableQualities?.length
    ? analysis.availableQualities.join(", ")
    : "Not available";
  selectedQuality.textContent = analysis.selectedQuality || "Not available";
  mediaContainer.textContent = analysis.media?.container || "Not available";
  segmentCount.textContent = Number.isInteger(analysis.media?.segmentCount)
    ? String(analysis.media.segmentCount)
    : "Not available";
  mediaDuration.textContent = formatDuration(analysis.media?.totalDuration);

  if (analysis.media) {
    encryptionStatus.textContent = analysis.media.isEncrypted
      ? `Yes ${analysis.media.encryptionMethods.join(", ")}`
      : "No";
  }
}

// renders all current tab and playlist state
function renderState(state, streamPermissionGranted) {
  const isCanvasPage = Boolean(state?.isCanvasPage);
  const hasStream = Boolean(state?.streamDetected && state.stream);
  const isAnalyzing = state?.analysis?.status === "loading";
  const hasAnalysisResult = ["ready", "partial", "error"].includes(
    state?.analysis?.status
  );

  pageTitle.textContent = state?.pageTitle || "Not detected";
  streamLabel.textContent = hasStream
    ? state.stream.safeLabel
    : "Not detected";
  detectedTime.textContent = hasStream
    ? formatDetectedTime(state.stream.detectedAt)
    : "Not available";

  renderAnalysis(state?.analysis);

  permissionButton.hidden = streamPermissionGranted;
  analyzeButton.disabled = !hasStream || isAnalyzing;
  analyzeButton.textContent = hasAnalysisResult
    ? "Analyze again"
    : "Analyze playlist";
  downloadButton.disabled = !hasStream;

  if (!isCanvasPage) {
    pageStatus.textContent = "This is not an FIU Canvas page.";
    helpText.textContent = "Open a page on fiu.instructure.com.";
    return;
  }

  if (!streamPermissionGranted) {
    pageStatus.textContent = "FIU Canvas page detected.";
    helpText.textContent =
      "Enable stream detection then reload the page and play the video.";
    return;
  }

  if (!hasStream) {
    pageStatus.textContent = "FIU Canvas page detected. Waiting for HLS.";
    helpText.textContent =
      "Reload the video page and press Play so Firefox requests the playlist.";
    return;
  }

  if (isAnalyzing) {
    pageStatus.textContent = "Reading HLS playlists.";
    helpText.textContent = "Keep this popup open until the analysis finishes.";
    return;
  }

  if (state?.analysis?.status === "error") {
    pageStatus.textContent = "HLS stream detected but analysis failed.";
    helpText.textContent =
      "Try Analyze again. A 401 or 403 may mean the server requires the original page request context.";
    return;
  }

  if (["ready", "partial"].includes(state?.analysis?.status)) {
    pageStatus.textContent = "HLS playlist analyzed.";
    helpText.textContent =
      state.analysis.warning ||
      "Phase 2 stops here. Segment downloading is not implemented yet.";
    return;
  }

  pageStatus.textContent = "Successful HLS playlist detected.";
  helpText.textContent = "Select Analyze playlist to read its HLS metadata.";
}

// loads the current tab state and updates the popup
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

// asks for optional stream host access after a button click
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

// starts playlist parsing for the current tab
analyzeButton.addEventListener("click", async () => {
  if (!Number.isInteger(activeTabId)) {
    return;
  }

  analyzeButton.disabled = true;
  helpText.textContent = "Reading the captured playlists.";

  try {
    const state = await browser.runtime.sendMessage({
      type: "ANALYZE_TAB",
      tabId: activeTabId
    });

    renderState(state, await hasStreamHostPermission());
  } catch {
    helpText.textContent =
      "The background script stopped before analysis finished. Try again.";
  }
});

// keeps download disabled as a real action during phase 2
downloadButton.addEventListener("click", () => {
  helpText.textContent =
    "The selected stream is ready for Phase 3. Segment downloading is not implemented yet.";
});

// refreshes the popup when background state changes
browser.runtime.onMessage.addListener((message) => {
  if (message?.type === "TAB_STATE_UPDATED" && message.tabId === activeTabId) {
    void refreshPopup();
  }
});

void refreshPopup();

