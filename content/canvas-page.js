let lastSentTitle = null;

// sends the current canvas title to the background script
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
      // extension may be reloading
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

