(() => {
  const HLS_TYPES = new Set([
    "application/vnd.apple.mpegurl",
    "application/x-mpegurl",
    "audio/mpegurl",
    "audio/x-mpegurl"
  ]);
  const DASH_TYPES = new Set(["application/dash+xml"]);
  const MP4_TYPES = new Set(["video/mp4", "application/mp4"]);
  const MOV_TYPES = new Set(["video/quicktime"]);

  // gets one response header without caring about letter case
  function getHeaderValue(headers, wantedName) {
    const wanted = String(wantedName || "").toLowerCase();
    const match = Array.isArray(headers)
      ? headers.find((header) => String(header.name || "").toLowerCase() === wanted)
      : null;

    return typeof match?.value === "string" ? match.value : "";
  }

  // removes charset and other values from a content type
  function normalizeContentType(value) {
    return String(value || "")
      .split(";", 1)[0]
      .trim()
      .toLowerCase();
  }

  // checks if a request completed with a usable status
  function isSuccessfulStatus(statusCode, sourceType) {
    if (sourceType === "direct") {
      return statusCode === 200 || statusCode === 206;
    }

    return statusCode === 200;
  }

  // checks if a url path has a file extension
  function pathEndsWith(url, pattern) {
    try {
      return pattern.test(new URL(url).pathname);
    } catch {
      return false;
    }
  }

  // checks if a url has a kaltura path
  function hasKalturaPath(rawUrl) {
    try {
      return /\/(playManifest|serveFlavor)\//i.test(new URL(rawUrl).pathname);
    } catch {
      return false;
    }
  }

  // checks if a host or path looks like kaltura
  function isKalturaUrl(rawUrl) {
    try {
      const url = new URL(rawUrl);
      return /kaltura/i.test(url.hostname) || hasKalturaPath(rawUrl);
    } catch {
      return false;
    }
  }

  // finds a private kaltura entry id without showing it to the popup
  function extractKalturaEntryId(...rawUrls) {
    for (const rawUrl of rawUrls) {
      if (!rawUrl) {
        continue;
      }

      try {
        const url = new URL(rawUrl);
        const pathMatch = url.pathname.match(/\/entryId\/([^/]+)/i);
        const queryValue =
          url.searchParams.get("entryId") ||
          url.searchParams.get("entry_id") ||
          url.searchParams.get("entryid");
        const value = pathMatch?.[1] || queryValue;

        if (value) {
          return value;
        }
      } catch {
        // ignore urls firefox did not parse
      }
    }

    return null;
  }

  // decides which provider made the request
  function detectProvider(details) {
    const urls = [details.url, details.documentUrl, details.originUrl];
    return urls.some((url) => url && isKalturaUrl(url)) ? "Kaltura" : "Other";
  }

  // checks if a kaltura manifest path names one format
  function pathHasFormat(rawUrl, formatName) {
    try {
      const path = new URL(rawUrl).pathname;
      return new RegExp(`/format/${formatName}(?:/|$)`, "i").test(path);
    } catch {
      return false;
    }
  }

  // identifies a completed video request from url and response type
  function classifyRequest(details) {
    if (!details || details.tabId < 0 || !details.url) {
      return null;
    }

    const contentType = normalizeContentType(
      getHeaderValue(details.responseHeaders, "content-type")
    );
    const hlsByUrl =
      pathEndsWith(details.url, /\.m3u8$/i) ||
      pathHasFormat(details.url, "applehttp");
    const dashByUrl =
      pathEndsWith(details.url, /\.mpd$/i) ||
      pathHasFormat(details.url, "mpegdash");
    const mp4ByUrl = pathEndsWith(details.url, /\.mp4$/i);
    const movByUrl = pathEndsWith(details.url, /\.mov$/i);

    let sourceType = null;
    let formatLabel = null;

    if (hlsByUrl || HLS_TYPES.has(contentType)) {
      sourceType = "hls";
      formatLabel = "HLS";
    } else if (dashByUrl || DASH_TYPES.has(contentType)) {
      sourceType = "dash";
      formatLabel = "MPEG-DASH";
    } else if (mp4ByUrl || MP4_TYPES.has(contentType)) {
      sourceType = "direct";
      formatLabel = "Direct MP4";
    } else if (movByUrl || MOV_TYPES.has(contentType)) {
      sourceType = "direct";
      formatLabel = "Direct MOV";
    }

    if (!sourceType || !isSuccessfulStatus(details.statusCode, sourceType)) {
      return null;
    }

    return {
      sourceType,
      formatLabel,
      contentType: contentType || "unknown",
      provider: detectProvider(details),
      entryId: extractKalturaEntryId(
        details.url,
        details.documentUrl,
        details.originUrl
      )
    };
  }

  // makes one private key for requests from the same player
  function makePrivateGroupKey(details, classification) {
    if (Number.isInteger(details.frameId) && details.frameId > 0) {
      return `frame:${details.frameId}`;
    }

    if (classification.entryId) {
      return `entry:${classification.entryId}`;
    }

    if (details.documentId) {
      return `document:${details.documentId}`;
    }

    if (Number.isInteger(details.frameId)) {
      return `frame:${details.frameId}`;
    }

    return `request:${details.requestId || crypto.randomUUID()}`;
  }

  // makes a safe request summary without a query string
  function summarizeUrl(rawUrl, formatLabel) {
    const url = new URL(rawUrl);
    const pathParts = url.pathname.split("/").filter(Boolean);
    const fileName = pathParts.at(-1) || formatLabel || "video source";

    return {
      host: url.hostname,
      fileName,
      safeLabel: `${formatLabel} on ${url.hostname}`,
      queryParameterCount: [...url.searchParams.keys()].length
    };
  }

  // makes a key that ignores signed query values
  function makeDedupeKey(rawUrl, sourceType) {
    try {
      const url = new URL(rawUrl);
      return `${sourceType}:${url.origin}${url.pathname}`;
    } catch {
      return `${sourceType}:${rawUrl}`;
    }
  }

  // tells the popup if phase 4a can analyze this source
  function canAnalyzeSource(sourceType) {
    return sourceType === "hls";
  }

  globalThis.MediaDetector = Object.freeze({
    canAnalyzeSource,
    classifyRequest,
    detectProvider,
    extractKalturaEntryId,
    getHeaderValue,
    makeDedupeKey,
    makePrivateGroupKey,
    normalizeContentType,
    summarizeUrl
  });
})();
