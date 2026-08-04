let lastSentTitle = null;

function sendPageMetadata() {
  const pageTitle = document.title.trim();

  if (pageTitle === lastSentTitle) {
    return;
  }

  lastSentTitle = pageTitle;

  browser.runtime
    .sendMessage({
      type: "CANVAS_PAGE_READY",
      pageTitle
    })
    .catch(() => {
      // The extension may be reloading while the page remains open.
    });
}

sendPageMetadata();

const titleElement = document.querySelector("title");

if (titleElement) {
  const titleObserver = new MutationObserver(sendPageMetadata);
  titleObserver.observe(titleElement, {
    childList: true,
    subtree: true,
    characterData: true
  });
}

window.addEventListener("pageshow", sendPageMetadata);
window.addEventListener("popstate", sendPageMetadata);
