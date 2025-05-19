
chrome.runtime.onInstalled.addListener(() =>
  console.log("[worker] ready")
);

chrome.webRequest.onBeforeSendHeaders.addListener(
  ({ requestHeaders, url }) => {
    const ctid = requestHeaders?.find(x => x.name.toLowerCase() === "x-client-transaction-id")?.value;
    chrome.storage.local.set({ timelineCTID: ctid });
  },
  { urls: ["https://x.com/i/api/graphql/*UserTweetsAndReplies*"] },
  ["requestHeaders", "extraHeaders"]    
);
