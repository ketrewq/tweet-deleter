chrome.runtime.onInstalled.addListener(() => {
  console.log("[worker] X Tweet Cleaner installed");

  chrome.storage.local.get("opts", ({ opts }) => {
    if (!opts) chrome.storage.local.set({ opts: {} });
  });
  
  chrome.storage.local.remove(["lastError"]);
});

// ─── Bearer 토큰 스니핑 ─────────────────────────────────────────────
chrome.webRequest.onSendHeaders.addListener(
  ({ requestHeaders }) => {
    const h = requestHeaders?.find(
      x => x.name.toLowerCase() === 'authorization'
    );
    if (h && h.value.startsWith('Bearer ')) {
      chrome.storage.local.set({ bearer: h.value });
      console.log('[worker] Bearer captured: ', h.value.slice(0, 40) + '…');
    }
  },
  { urls: [
      'https://x.com/i/api/graphql/*',
      'https://twitter.com/i/api/graphql/*'
    ] },
  ['requestHeaders', 'extraHeaders']
);


chrome.webRequest.onBeforeSendHeaders.addListener(
  ({ requestHeaders, url }) => {

    const M = url.match(/\/graphql\/([\w-]{20,})\/(?:UserTweetsAndReplies|UserTweets)\?(.*)/);
    if (!M) return;

    try {
      const h = name => requestHeaders?.find(x => x.name.toLowerCase() === name.toLowerCase())?.value;
      const bearer = h("authorization");
      const ctid = h("x-client-transaction-id");
      const csrf = h("x-csrf-token");
      
      if (!bearer || !ctid || !csrf) {
        console.warn("[worker] Missing important headers:", { 
          bearer: !!bearer, 
          ctid: !!ctid, 
          csrf: !!csrf 
        });
        return;
      }

      const qs = M[2].replace(/^variables=[^&]+&/, "");

      chrome.storage.local.set({
        bearer,
        timelineCTID: ctid,
        csrf: csrf,
        tweetsQry: M[1],
        tweetsQS: qs,
        lastCapture: Date.now()  
      });
      
      console.log("[worker] API credentials captured", {
        bearer: bearer ? "✓" : "✗",
        ctid: ctid ? "✓" : "✗",
        csrf: csrf ? "✓" : "✗",
        queryId: M[1],
        qsLength: qs.length,
        timestamp: new Date().toISOString()
      });
    } catch (err) {
      console.error("[worker] Error processing API request:", err);
      chrome.storage.local.set({ lastError: err.message });
    }
  },
  { urls: [
    "https://x.com/i/api/graphql/*UserTweetsAndReplies*",
    "https://twitter.com/i/api/graphql/*UserTweetsAndReplies*",
    "https://x.com/i/api/graphql/*UserTweets*",
    "https://twitter.com/i/api/graphql/*UserTweets*"
  ] },
  ["requestHeaders", "extraHeaders"]
);

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.cmd !== "inject-cleaner") return false;
  const tabId = msg.tabId;

  chrome.scripting.executeScript({
    target: { tabId },
    files: ["cleaner.js"],
    world: "ISOLATED"
  }).then(() => {
    return chrome.storage.local.get(["opts", "bearer", "timelineCTID", "tweetsQry", "tweetsQS", "csrf"]);
  }).then((data) => {
    const now = Date.now();
    const lastCapture = data.lastCapture || 0;
    const isStale = now - lastCapture > 3600000; 
    
    if (isStale) {
      console.warn("[worker] Using potentially stale credentials from", new Date(lastCapture).toISOString());
    }
    
    console.log("[worker] Sending to cleaner:", {
      opts: data.opts,
      bearerPresent: !!data.bearer,
      ctidPresent: !!data.timelineCTID,
      queryPresent: !!data.tweetsQry,
      csrfPresent: !!data.csrf,
      credentialsAge: lastCapture ? Math.round((now - lastCapture) / 1000) + " seconds" : "unknown"
    });

    chrome.tabs.sendMessage(tabId, {
      cmd: "tweet-clean",
      opts: data.opts,
      credentials: {
        bearer: data.bearer,
        timelineCTID: data.timelineCTID,
        tweetsQry: data.tweetsQry,
        tweetsQS: data.tweetsQS,
        csrf: data.csrf
      }
    });
    
    sendResponse({ ok: true });
  }).catch(e => {
    console.error("[worker] Injection failed", e);
    chrome.storage.local.set({ lastError: e.message });
    sendResponse({ ok: false, err: e.message });
  });
  
  return true;
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.cmd === "get-status") {
    chrome.storage.local.get(["bearer", "timelineCTID", "tweetsQry", "lastCapture", "lastError"], (data) => {
      sendResponse({
        hasAuth: !!(data.bearer && data.timelineCTID && data.tweetsQry),
        lastCapture: data.lastCapture || null,
        lastError: data.lastError || null
      });
    });
    return true;
  }
});