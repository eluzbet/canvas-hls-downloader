(() => {
  const PLAYLIST_HEADER = "#EXTM3U";

  // turns playlist text into clean lines
  function normalizeLines(text) {
    return String(text)
      .replace(/^\uFEFF/, "")
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
  }

  // removes matching quotes from one value
  function stripQuotes(value) {
    if (
      value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'")))
    ) {
      return value.slice(1, -1);
    }

    return value;
  }

  // splits an hls attribute list without breaking quoted commas
  function splitAttributeList(input) {
    const parts = [];
    let current = "";
    let quote = null;

    for (const character of input) {
      if ((character === '"' || character === "'") && !quote) {
        quote = character;
        current += character;
        continue;
      }

      if (character === quote) {
        quote = null;
        current += character;
        continue;
      }

      if (character === "," && !quote) {
        parts.push(current.trim());
        current = "";
        continue;
      }

      current += character;
    }

    if (current.trim()) {
      parts.push(current.trim());
    }

    return parts;
  }

  // parses key value attributes from hls tags
  function parseAttributeList(input) {
    const attributes = {};

    for (const part of splitAttributeList(input)) {
      const separatorIndex = part.indexOf("=");

      if (separatorIndex < 1) {
        continue;
      }

      const key = part.slice(0, separatorIndex).trim().toUpperCase();
      const rawValue = part.slice(separatorIndex + 1).trim();
      attributes[key] = stripQuotes(rawValue);
    }

    return attributes;
  }

  // turns a numeric attribute into a safe number
  function parseNumber(value) {
    if (value == null || value === "") {
      return null;
    }

    const number = Number(value);
    return Number.isFinite(number) ? number : null;
  }

  // parses width and height from the resolution attribute
  function parseResolution(value) {
    if (typeof value !== "string") {
      return {
        width: null,
        height: null
      };
    }

    const match = value.match(/^(\d+)x(\d+)$/i);

    if (!match) {
      return {
        width: null,
        height: null
      };
    }

    return {
      width: Number(match[1]),
      height: Number(match[2])
    };
  }

  // resolves a relative playlist or segment uri
  function resolveUri(reference, baseUrl) {
    return new URL(reference, baseUrl).href;
  }

  // makes a short safe label from a url
  function summarizeUrl(rawUrl) {
    const url = new URL(rawUrl);
    const pathParts = url.pathname.split("/").filter(Boolean);
    const fileName = pathParts.at(-1) || "playlist.m3u8";

    return {
      host: url.hostname,
      fileName,
      safeLabel: `${fileName} on ${url.hostname}`
    };
  }

  // checks if the playlist has master playlist tags
  function isMasterPlaylist(lines) {
    return lines.some(
      (line) =>
        line.startsWith("#EXT-X-STREAM-INF:") ||
        line.startsWith("#EXT-X-I-FRAME-STREAM-INF:")
    );
  }

  // checks if the playlist has media playlist tags
  function isMediaPlaylist(lines) {
    return lines.some(
      (line) =>
        line.startsWith("#EXTINF:") ||
        line.startsWith("#EXT-X-TARGETDURATION:") ||
        line.startsWith("#EXT-X-MAP:")
    );
  }

  // parses variants from a master playlist
  function parseMasterPlaylist(lines, baseUrl) {
    const variants = [];

    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index];

      if (!line.startsWith("#EXT-X-STREAM-INF:")) {
        continue;
      }

      const attributes = parseAttributeList(
        line.slice("#EXT-X-STREAM-INF:".length)
      );
      const uriLine = lines[index + 1];

      if (!uriLine || uriLine.startsWith("#")) {
        continue;
      }

      const url = resolveUri(uriLine, baseUrl);
      const resolution = parseResolution(attributes.RESOLUTION);
      const summary = summarizeUrl(url);

      variants.push({
        url,
        host: summary.host,
        fileName: summary.fileName,
        safeLabel: summary.safeLabel,
        bandwidth: parseNumber(attributes.BANDWIDTH),
        averageBandwidth: parseNumber(attributes["AVERAGE-BANDWIDTH"]),
        width: resolution.width,
        height: resolution.height,
        frameRate: parseNumber(attributes["FRAME-RATE"]),
        codecs: attributes.CODECS || "",
        audioGroup: attributes.AUDIO || "",
        subtitlesGroup: attributes.SUBTITLES || ""
      });
    }

    return {
      type: "master",
      variants
    };
  }

  // guesses the media container from playlist details
  function detectContainer(initSegment, segments) {
    if (initSegment) {
      return "fragmented MP4";
    }

    for (const segment of segments) {
      const pathname = new URL(segment.url).pathname.toLowerCase();

      if (
        pathname.endsWith(".m4s") ||
        pathname.endsWith(".mp4") ||
        pathname.endsWith(".cmfv") ||
        pathname.endsWith(".cmfa")
      ) {
        return "fragmented MP4";
      }

      if (pathname.endsWith(".ts")) {
        return "MPEG-TS";
      }

      if (pathname.endsWith(".aac")) {
        return "AAC";
      }
    }

    return "unknown";
  }

  // parses segments and metadata from a media playlist
  function parseMediaPlaylist(lines, baseUrl) {
    const segments = [];
    const encryptionMethods = new Set();
    let initSegment = null;
    let targetDuration = null;
    let mediaSequence = 0;
    let pendingDuration = null;
    let pendingTitle = "";
    let pendingByteRange = null;
    let pendingDiscontinuity = false;
    let hasEndList = false;

    for (const line of lines) {
      if (line.startsWith("#EXT-X-TARGETDURATION:")) {
        targetDuration = parseNumber(
          line.slice("#EXT-X-TARGETDURATION:".length)
        );
        continue;
      }

      if (line.startsWith("#EXT-X-MEDIA-SEQUENCE:")) {
        mediaSequence =
          parseNumber(line.slice("#EXT-X-MEDIA-SEQUENCE:".length)) || 0;
        continue;
      }

      if (line.startsWith("#EXT-X-MAP:")) {
        const attributes = parseAttributeList(line.slice("#EXT-X-MAP:".length));

        if (attributes.URI) {
          initSegment = {
            url: resolveUri(attributes.URI, baseUrl),
            byteRange: attributes.BYTERANGE || null
          };
        }

        continue;
      }

      if (line.startsWith("#EXT-X-KEY:")) {
        const attributes = parseAttributeList(line.slice("#EXT-X-KEY:".length));
        const method = attributes.METHOD || "UNKNOWN";

        if (method !== "NONE") {
          encryptionMethods.add(method);
        }

        continue;
      }

      if (line.startsWith("#EXT-X-BYTERANGE:")) {
        pendingByteRange = line.slice("#EXT-X-BYTERANGE:".length).trim();
        continue;
      }

      if (line === "#EXT-X-DISCONTINUITY") {
        pendingDiscontinuity = true;
        continue;
      }

      if (line === "#EXT-X-ENDLIST") {
        hasEndList = true;
        continue;
      }

      if (line.startsWith("#EXTINF:")) {
        const value = line.slice("#EXTINF:".length);
        const commaIndex = value.indexOf(",");
        const durationText = commaIndex >= 0 ? value.slice(0, commaIndex) : value;

        pendingDuration = parseNumber(durationText);
        pendingTitle = commaIndex >= 0 ? value.slice(commaIndex + 1).trim() : "";
        continue;
      }

      if (line.startsWith("#")) {
        continue;
      }

      segments.push({
        sequence: mediaSequence + segments.length,
        url: resolveUri(line, baseUrl),
        duration: pendingDuration,
        title: pendingTitle,
        byteRange: pendingByteRange,
        discontinuity: pendingDiscontinuity
      });

      pendingDuration = null;
      pendingTitle = "";
      pendingByteRange = null;
      pendingDiscontinuity = false;
    }

    const totalDuration = segments.reduce(
      (total, segment) => total + (segment.duration || 0),
      0
    );

    return {
      type: "media",
      targetDuration,
      mediaSequence,
      initSegment,
      segments,
      segmentCount: segments.length,
      totalDuration,
      hasEndList,
      hasDiscontinuity: segments.some((segment) => segment.discontinuity),
      byteRangeCount: segments.filter((segment) => segment.byteRange).length,
      isEncrypted: encryptionMethods.size > 0,
      encryptionMethods: [...encryptionMethods],
      container: detectContainer(initSegment, segments)
    };
  }

  // parses one hls master or media playlist
  function parsePlaylist(text, baseUrl) {
    const lines = normalizeLines(text);

    if (lines[0] !== PLAYLIST_HEADER) {
      throw new Error("INVALID_HLS_PLAYLIST");
    }

    if (isMasterPlaylist(lines)) {
      return parseMasterPlaylist(lines, baseUrl);
    }

    if (isMediaPlaylist(lines)) {
      return parseMediaPlaylist(lines, baseUrl);
    }

    return {
      type: "unknown"
    };
  }

  // picks the highest resolution then the highest bandwidth
  function selectBestVariant(variants) {
    if (!Array.isArray(variants) || variants.length === 0) {
      return null;
    }

    return [...variants].sort((left, right) => {
      const leftPixels = (left.width || 0) * (left.height || 0);
      const rightPixels = (right.width || 0) * (right.height || 0);

      if (rightPixels !== leftPixels) {
        return rightPixels - leftPixels;
      }

      const leftBandwidth = left.bandwidth || left.averageBandwidth || 0;
      const rightBandwidth = right.bandwidth || right.averageBandwidth || 0;
      return rightBandwidth - leftBandwidth;
    })[0];
  }

  globalThis.HlsParser = Object.freeze({
    parsePlaylist,
    selectBestVariant,
    summarizeUrl
  });
})();
