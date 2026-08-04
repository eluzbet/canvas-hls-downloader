const CANVAS_ORIGIN = "https://fiu.instructure.com";
const STREAM_ORIGINS = ["<all_urls>"];
const ACTIVE_DOWNLOAD_STATUSES = new Set([
  "preparing",
  "downloading",
  "saving",
  "canceling"
]);

const videoSelector = document.querySelector("#video-selector");
const videoCount = document.querySelector("#video-count");
const pageStatus = document.querySelector("#page-status");
const pageTitle = document.querySelector("#page-title");
const videoProvider = document.querySelector("#video-provider");
const videoSource = document.querySelector("#video-source");
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
const downloadStatus = document.querySelector("#download-status");
const downloadFilename = document.querySelector("#download-filename");
const downloadProgressText = document.querySelector("#download-progress-text");
const downloadSize = document.querySelector("#download-size");
const downloadSpeed = document.querySelector("#download-speed");
const downloadProgress = document.querySelector("#download-progress");
const permissionButton = document.querySelector("#permission-button");
const analyzeButton = document.querySelector("#analyze-button");
const downloadButton = document.querySelector("#download-button");
const cancelButton = document.querySelector("#cancel-button");
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

// formats bytes for the popup
function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) {
    return "Not available";
  }

  const units = ["B", "KB", "MB", "GB", "TB"];
  const unitIndex = Math.min(
    units.length - 1,
    Math.floor(Math.log(bytes) / Math.log(1024))
  );
  const value = bytes / 1024 ** unitIndex;
  const decimals = value >= 100 || unitIndex === 0 ? 0 : value >= 10 ? 1 : 2;

  return `${value.toFixed(decimals)} ${units[unitIndex]}`;
}

// formats a byte speed for the popup
function formatSpeed(bytesPerSecond) {
  if (!Number.isFinite(bytesPerSecond) || bytesPerSecond <= 0) {
    return "Not available";
  }

  return `${formatBytes(bytesPerSecond)}/s`;
}

// checks if stream host access is already granted
async function hasStreamHostPermission() {
  return browser.permissions.contains({
    origins: STREAM_ORIGINS
  });
}

// finds the selected video summary
function getSelectedVideo(state) {
  return state?.videos?.find((video) => video.id === state.selectedVideoId) || null;
}

// makes one readable selector label
function makeVideoOptionLabel(video) {
  const sourceText = video.sourceTypes?.length
    ? video.sourceTypes.join(" + ")
    : "source waiting";
  return `${video.label} · ${video.provider} · ${sourceText}`;
}

// fills the multi video selector
function renderVideoSelector(state, downloadIsActive) {
  const videos = Array.isArray(state?.videos) ? state.videos : [];
  videoSelector.textContent = "";

  if (videos.length === 0) {
    const option = document.createElement("option");
    option.value = "";
    option.textContent = "No video detected";
    videoSelector.append(option);
    videoSelector.disabled = true;
    videoCount.textContent = "0 videos found";
    return;
  }

  for (const video of videos) {
    const option = document.createElement("option");
    option.value = video.id;
    option.textContent = makeVideoOptionLabel(video);
    option.selected = video.id === state.selectedVideoId;
    videoSelector.append(option);
  }

  videoSelector.disabled = videos.length < 2 || downloadIsActive;
  videoCount.textContent = `${videos.length} video${videos.length === 1 ? "" : "s"} found`;
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

// turns a download status into readable text
function makeDownloadStatusLabel(download) {
  const labels = {
    idle: "Not started",
    preparing: "Preparing",
    downloading: "Downloading segments",
    saving: "Saving through Firefox",
    canceling: "Canceling",
    canceled: "Canceled",
    complete: "Complete",
    error: download?.error?.message || "Failed"
  };

  return labels[download?.status] || "Not started";
}

// writes download details into the popup
function renderDownload(download) {
  const progress = Number(download?.progressPercent || 0);
  const completedSegments = Number(download?.completedSegments || 0);
  const totalSegments = Number(download?.totalSegments || 0);

  downloadStatus.textContent = makeDownloadStatusLabel(download);
  downloadFilename.textContent = download?.filename || "Not available";
  downloadProgress.value = Math.max(0, Math.min(100, progress));
  downloadProgressText.textContent = totalSegments
    ? `${completedSegments} of ${totalSegments} segments ${Math.round(progress)}%`
    : "Not available";
  downloadSize.textContent = formatBytes(download?.downloadedBytes);
  downloadSpeed.textContent = formatSpeed(download?.speedBytesPerSecond);
}

// checks why the current analysis cannot download yet
function getDownloadBlockReason(state) {
  const analysis = state?.analysis;

  if (analysis?.status !== "ready") {
    return "Analyze the HLS playlist before downloading";
  }

  if (analysis.media?.container !== "MPEG-TS") {
    return "Phase 4A only downloads MPEG TS HLS streams";
  }

  if (analysis.media?.isEncrypted) {
    return "Encrypted HLS streams are not supported in Phase 4A";
  }

  if (analysis.media?.hasInitSegment) {
    return "Initialization segments are handled in a later phase";
  }

  if (!analysis.media?.hasEndList) {
    return "Live HLS playlists are not supported in Phase 4A";
  }

  if (analysis.media?.hasDiscontinuity) {
    return "Playlists with discontinuities are not supported in Phase 4A";
  }

  if (analysis.selectedStream?.audioGroup) {
    return "Separate audio groups are not supported in Phase 4A";
  }

  return null;
}

// renders all current tab video analysis and download state
function renderState(state, streamPermissionGranted) {
  const isCanvasPage = Boolean(state?.isCanvasPage);
  const selectedVideo = getSelectedVideo(state);
  const hasSource = Boolean(state?.streamDetected && state.stream);
  const hasHls = Boolean(selectedVideo?.canAnalyzeHls);
  const isAnalyzing = state?.analysis?.status === "loading";
  const downloadIsActive = ACTIVE_DOWNLOAD_STATUSES.has(state?.download?.status);
  const hasAnalysisResult = ["ready", "partial", "error"].includes(
    state?.analysis?.status
  );
  const downloadBlockReason = getDownloadBlockReason(state);

  renderVideoSelector(state, downloadIsActive);
  pageTitle.textContent = state?.pageTitle || "Not detected";
  videoProvider.textContent = selectedVideo?.provider || "Not detected";
  videoSource.textContent = selectedVideo?.sourceTypes?.length
    ? selectedVideo.sourceTypes.join(", ")
    : "Not detected";
  streamLabel.textContent = hasSource
    ? state.stream.safeLabel
    : "Not detected";
  detectedTime.textContent = hasSource
    ? formatDetectedTime(state.stream.detectedAt)
    : "Not available";

  renderAnalysis(state?.analysis);
  renderDownload(state?.download);

  permissionButton.hidden = streamPermissionGranted;
  analyzeButton.disabled = !hasHls || isAnalyzing || downloadIsActive;
  analyzeButton.textContent = hasAnalysisResult
    ? "Analyze again"
    : "Analyze playlist";
  downloadButton.disabled = Boolean(downloadBlockReason) || downloadIsActive;
  downloadButton.textContent =
    state?.download?.status === "complete"
      ? "Download again"
      : "Download MPEG-TS";
  cancelButton.hidden = !downloadIsActive;
  cancelButton.disabled =
    !downloadIsActive || state?.download?.status === "canceling";

  if (!isCanvasPage) {
    pageStatus.textContent = "This is not an FIU Canvas page.";
    helpText.textContent = "Open a page on fiu.instructure.com.";
    return;
  }

  if (!streamPermissionGranted) {
    pageStatus.textContent = "FIU Canvas page detected.";
    helpText.textContent =
      "Enable stream detection then reload the page and play each video.";
    return;
  }

  if (!hasSource) {
    pageStatus.textContent = "FIU Canvas page detected. Waiting for video sources.";
    helpText.textContent =
      "Press Play on each embedded video so Firefox requests its media source.";
    return;
  }

  if (!hasHls) {
    pageStatus.textContent = `${state.stream.formatLabel} source detected.`;
    helpText.textContent =
      state.stream.sourceType === "direct"
        ? "Direct video download will be added in Phase 4B. Select another video if it has HLS."
        : "MPEG DASH download will be added later. Select another video if it has HLS.";
    return;
  }

  if (isAnalyzing) {
    pageStatus.textContent = "Reading the selected HLS playlists.";
    helpText.textContent = "Keep this popup open until the analysis finishes.";
    return;
  }

  if (downloadIsActive) {
    pageStatus.textContent = "Downloading the selected MPEG TS stream.";
    helpText.textContent =
      state.download.status === "saving"
        ? "Firefox is copying the completed file to your Downloads folder."
        : "You can close the popup but keep the Canvas tab open.";
    return;
  }

  if (state?.download?.status === "complete") {
    pageStatus.textContent = "Video download complete.";
    helpText.textContent = "The MPEG TS file was saved through Firefox Downloads.";
    return;
  }

  if (state?.download?.status === "canceled") {
    pageStatus.textContent = "Video download canceled.";
    helpText.textContent = "You can start the selected video again.";
    return;
  }

  if (state?.download?.status === "error") {
    pageStatus.textContent = "Video download failed.";
    helpText.textContent = state.download.error?.message || "Try again.";
    return;
  }

  if (state?.analysis?.status === "error") {
    pageStatus.textContent = "HLS source detected but analysis failed.";
    helpText.textContent =
      "Try Analyze again. A 401 or 403 may mean the server requires the original page request context.";
    return;
  }

  if (["ready", "partial"].includes(state?.analysis?.status)) {
    pageStatus.textContent = "HLS playlist analyzed.";
    helpText.textContent =
      downloadBlockReason ||
      state.analysis.warning ||
      "The selected MPEG TS stream is ready to download.";
    return;
  }

  pageStatus.textContent = "Video source detected.";
  helpText.textContent = "Select Analyze playlist to read the selected HLS metadata.";
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
    "Permission granted. Reload the Canvas page and press Play on each video.";
});

// changes which detected video the popup controls
videoSelector.addEventListener("change", async () => {
  if (!Number.isInteger(activeTabId) || !videoSelector.value) {
    return;
  }

  videoSelector.disabled = true;

  try {
    const state = await browser.runtime.sendMessage({
      type: "SELECT_VIDEO",
      tabId: activeTabId,
      videoId: videoSelector.value
    });

    renderState(state, await hasStreamHostPermission());
  } catch {
    helpText.textContent = "Firefox could not change the selected video.";
  }
});

// starts playlist parsing for the selected video
analyzeButton.addEventListener("click", async () => {
  if (!Number.isInteger(activeTabId)) {
    return;
  }

  analyzeButton.disabled = true;
  helpText.textContent = "Reading the selected video playlists.";

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

// starts the selected mpeg ts download
downloadButton.addEventListener("click", async () => {
  if (!Number.isInteger(activeTabId)) {
    return;
  }

  downloadButton.disabled = true;
  helpText.textContent = "Preparing the selected MPEG TS stream.";

  try {
    const state = await browser.runtime.sendMessage({
      type: "START_DOWNLOAD",
      tabId: activeTabId
    });

    renderState(state, await hasStreamHostPermission());
  } catch {
    helpText.textContent = "Firefox could not start the download. Try again.";
  }
});

// cancels the current segment or browser save operation
cancelButton.addEventListener("click", async () => {
  if (!Number.isInteger(activeTabId)) {
    return;
  }

  cancelButton.disabled = true;
  helpText.textContent = "Canceling the current download.";

  try {
    const state = await browser.runtime.sendMessage({
      type: "CANCEL_DOWNLOAD",
      tabId: activeTabId
    });

    renderState(state, await hasStreamHostPermission());
  } catch {
    helpText.textContent = "Firefox could not cancel the download cleanly.";
  }
});

// refreshes the popup when background state changes
browser.runtime.onMessage.addListener((message) => {
  if (message?.type === "TAB_STATE_UPDATED" && message.tabId === activeTabId) {
    void refreshPopup();
  }
});

void refreshPopup();
