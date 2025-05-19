if (window.__tweetCleanerLoaded) {
    console.log("Tweet-Cleaner already injected – skip");
} else {
    window.__tweetCleanerLoaded = true;

    (async () => {

        /* ───── helper ───── */
        const sleep = ms => new Promise(r => setTimeout(r, ms));
        const getCK = n => document.cookie.split("; ")
            .find(r => r.startsWith(n + "="))?.split("=")[1];
        const rand = () => crypto.randomUUID().replace(/-/g, "") + "==";
        const AL = () => navigator.languages?.join(",") || "en-US,en;q=0.9";

        const log = (msg, ...args) => {
            const timestamp = new Date().toISOString().substring(11, 19);
            console.log(`[${timestamp}] ${msg}`, ...args);
        };

        /* ───── 번들 스캔 (fallback) ───── */
        async function scanQueryId() {
            log("Scanning bundles for queryId...");
            const manifest = await (await fetch("/manifest.json")).json();
            for (const p of Object.values(manifest)) {
                if (typeof p !== "string" || !p.endsWith(".js")) continue;
                const txt = await (await fetch(p)).text();
                const m = txt.match(/UserTweetsAndReplies.{1,120}?"queryId":"([\w-]{20,})"/);
                if (m) return m[1];
            }
            throw new Error("queryId not found in bundles");
        }

        /* ───── popup → content script 메시지 ───── */
        chrome.runtime.onMessage.addListener(async (message) => {

            log("Tweet Cleaner received message:", message);
            
            if (message.cmd !== "tweet-clean") return;

            let opts = message.opts;
            let credentials = message.credentials || {};

            opts = opts || {};
            opts.ids = Array.isArray(opts.ids) ? opts.ids : [];
            opts.ignore = Array.isArray(opts.ignore) ? opts.ignore : [];
            opts.keywords = Array.isArray(opts.keywords) ? opts.keywords : [];
            opts.unretweet = opts.unretweet ?? true;
            opts.keepPin = opts.keepPin ?? true;
            opts.linkOnly = opts.linkOnly ?? false;

            opts.debug = opts.debug ?? false;

            let bearer = credentials.bearer;
            let tweetsQry = credentials.tweetsQry;
            let tweetsQS = credentials.tweetsQS;
            let timelineCTID = credentials.timelineCTID;
            

            if (!bearer || !tweetsQry || !timelineCTID) {
                log("Credentials not found in message, checking storage...");
                const stored = await chrome.storage.local.get(["bearer", "tweetsQry", "tweetsQS", "timelineCTID"]);
                bearer = bearer || stored.bearer;
                tweetsQry = tweetsQry || stored.tweetsQry;
                tweetsQS = tweetsQS || stored.tweetsQS;
                timelineCTID = timelineCTID || stored.timelineCTID;
            }

            log("Using credentials:", {
                bearer: bearer ? "present" : "missing",
                tweetsQry: tweetsQry || "missing",
                timelineCTID: timelineCTID || "missing"
            });

            if (!bearer || !tweetsQry || !timelineCTID) {
                alert("세션 정보가 아직 캡처되지 않았습니다.\n" +
                    "X.com 프로필을 새로고침 ▶ 트윗 몇 줄 스크롤 ▶ 다시 Run");
                return;
            }
            
            const timelineTid = timelineCTID || rand();

            let queryId = tweetsQry;
            if (!queryId) queryId = await scanQueryId();  

            const qsTmpl = (tweetsQS || "").replace(/^variables=.*?&/, ""); 

            const csrf = getCK("ct0");
            const uid = getCK("twid")?.substring(4);
            const lang = navigator.language.split("-")[0];
            const ua = navigator.userAgentData.brands
                .map(b => `"${b.brand}";v="${b.version}"`).join(", ");

            async function fetchTweets(cursor, retryCount = 0) {
                const vars = {
                    userId: uid, 
                    count: 40, 
                    includePromotedContent: true, 
                    withCommunity: true, 
                    withVoice: true,
                    ...(cursor ? { cursor } : {})
                };

                const url = `https://x.com/i/api/graphql/${tweetsQry}/UserTweetsAndReplies` +
                    `?variables=${encodeURIComponent(JSON.stringify(vars))}` +
                    `&${tweetsQS}`;         

                log(`Fetching tweets${cursor ? ` (cursor: ${cursor.slice(0,10)}...)` : ""}${retryCount > 0 ? ` (retry ${retryCount})` : ""}`);
                
                try {
                    const r = await fetch(url, {
                        headers: {
                            accept: "*/*", 
                            "accept-language": AL(), 
                            authorization: bearer,
                            "x-csrf-token": csrf,
                            "x-client-transaction-id": timelineTid,
                            "x-twitter-active-user": "yes", 
                            "x-twitter-auth-type": "OAuth2Session",
                            "x-twitter-client-language": lang,
                            "sec-ch-ua": ua, 
                            "sec-ch-ua-mobile": "?0", 
                            "sec-ch-ua-platform": "\"Windows\""
                        },
                        credentials: "include"
                    });
                    
                    if (r.status === 429) {
                        if (retryCount < 3) {
                            log("Rate limited (429), waiting and retrying...");
                            const waitTime = Math.pow(2, retryCount) * 10000; // Exponential backoff
                            await sleep(waitTime);
                            return fetchTweets(cursor, retryCount + 1);
                        } else {
                            throw new Error("Rate limit exceeded after multiple retries");
                        }
                    }
                    
                    if (!r.ok) {
                        log("Timeline fetch failed:", r.status);
                        const text = await r.text();
                        log("Response:", text);
                        throw new Error("timeline fetch " + r.status);
                    }
                    
                    return r.json();
                } catch (err) {
                    if (retryCount < 3) {
                        log(`Fetch error: ${err.message}. Retrying in ${2 * (retryCount + 1)}s...`);
                        await sleep(2000 * (retryCount + 1));
                        return fetchTweets(cursor, retryCount + 1);
                    }
                    throw err;
                }
            }

            const pass = n => {
                const L = n.legacy;
                
                if (!L) {
                    log("Skipping tweet with no legacy data", n);
                    return false;
                }
                

                if (opts.debug) {
                    log("Evaluating tweet:", {
                        id: L.id_str,
                        text: L.full_text?.substring(0, 50),
                        created_at: L.created_at,
                        is_retweet: L.full_text?.startsWith("RT ") || false
                    });
                }
                
                if (opts.ignore.includes(L.id_str)) {
                    if (opts.debug) log("Skipping ignored tweet:", L.id_str);
                    return false;
                }
                
                if (opts.ids.length && !opts.ids.includes(L.id_str)) {
                    if (opts.debug) log("Skipping tweet not in ID list:", L.id_str);
                    return false;
                }
                
                if (opts.linkOnly && !(L.entities?.urls?.length)) {
                    if (opts.debug) log("Skipping tweet with no links:", L.id_str);
                    return false;
                }
                
                if (opts.keywords.length) {
                    const hasKeyword = opts.keywords.some(k => L.full_text?.includes(k));
                    if (!hasKeyword) {
                        if (opts.debug) log("Skipping tweet without keywords:", L.id_str);
                        return false;
                    }
                }
                
                if (L.created_at) {
                    const d = new Date(L.created_at);
                    if (opts.after && d < new Date(opts.after)) {
                        if (opts.debug) log("Skipping tweet before date range:", L.id_str);
                        return false;
                    }
                    if (opts.before && d > new Date(opts.before)) {
                        if (opts.debug) log("Skipping tweet after date range:", L.id_str);
                        return false;
                    }
                }
                
                if (!opts.unretweet && L.full_text?.startsWith("RT ")) {
                    if (opts.debug) log("Skipping retweet:", L.id_str);
                    return false;
                }
                

                if (opts.keepPin && L.pinned_tweet_ids_str?.length && L.pinned_tweet_ids_str.includes(L.id_str)) {
                    if (opts.debug) log("Skipping pinned tweet:", L.id_str);
                    return false;
                }
                
                return true;
            };

            async function harvest() {
                const ids = [];
                let cursor = null;
                let done = false;
                let emptyResponseCount = 0;
                const maxEmpty = 3;
                
                while (!done) {
                    try {
                        const data = await fetchTweets(cursor);

                        const instPaths = [
                            data?.data?.user?.result?.timeline?.timeline?.instructions,
                            data?.data?.user?.result?.timeline_v2?.timeline?.instructions,
                            data?.data?.user_result?.result?.timeline?.timeline?.instructions,
                            data?.data?.user_timeline_result?.timeline?.instructions
                        ];
                        
                        let inst = null;
                        for (const path of instPaths) {
                            if (Array.isArray(path)) {
                                inst = path;
                                break;
                            }
                        }
                        
                        if (!inst) {
                            log("No instructions found in response. Response structure:", JSON.stringify(data).substring(0, 500) + "...");
                            emptyResponseCount++;
                            if (emptyResponseCount >= maxEmpty) {
                                log("Too many empty responses, stopping harvest");
                                break;
                            }
                            await sleep(1000);
                            continue;
                        }

                        let foundEntries = false;
                        let foundCursor = false;
                        
                        for (const blk of inst) {
                            if (!['TimelineAddEntries', 'TimelineAddToModule'].includes(blk.type)) continue;
                            
                            for (const e of blk.entries || []) {

                                if (e.entryId?.startsWith("tweet-")) {
                                    foundEntries = true;
                                    const tweetResult = e.content?.itemContent?.tweet_results?.result ||
                                                      e.content?.items?.[0]?.item?.itemContent?.tweet_results?.result;
                                    
                                    if (tweetResult) {
   
                                        const tweetToCheck = tweetResult.legacy ? 
                                            tweetResult : 
                                            tweetResult.tweet || tweetResult;
                                            
                                        if (tweetToCheck && pass(tweetToCheck)) {
                                            const tweetId = tweetToCheck.rest_id || tweetToCheck.legacy?.id_str;
                                            if (tweetId && !ids.includes(tweetId)) {
                                                ids.push(tweetId);
                                                log("Found tweet to delete:", tweetToCheck.legacy?.full_text?.substring(0, 50) + "...");
                                            }
                                        }
                                    }
                                }
                                

                                if (e.entryId?.startsWith("cursor-bottom-") || 
                                    e.entryId?.includes("cursor-bottom")) {
                                    const newCursor = e.content?.value || e.content?.itemContent?.value;
                                    if (newCursor && newCursor !== cursor) {
                                        cursor = newCursor;
                                        foundCursor = true;
                                        log(`Found next cursor: ${cursor.substring(0, 15)}...`);
                                    }
                                }
                            }
                        }
                        

                        if (!foundEntries) {
                            log("No tweet entries found in this batch");
                            emptyResponseCount++;
                        } else {
                            emptyResponseCount = 0; 
                        }
                        
                        if (!foundCursor) {
                            log("No cursor found, we've reached the end");
                            done = true;
                        }
                        
                        if (emptyResponseCount >= maxEmpty) {
                            log("Too many empty responses, stopping harvest");
                            done = true;
                        }
                        
                        
                        log(`Progress: found ${ids.length} tweets to delete so far`);
                        

                        await sleep(1000);
                    } catch (err) {
                        log("Error harvesting tweets:", err);
                        await sleep(5000); // Longer pause on error
                        emptyResponseCount++;
                        if (emptyResponseCount >= maxEmpty) {
                            log("Too many errors, stopping harvest");
                            break;
                        }
                    }
                }
                
                return ids;
            }

            async function nuke(list) {
                const delEP = "https://x.com/i/api/graphql/VaenaVgh5q5ih7kvyVjgtg/DeleteTweet";
                const delTid = rand();
                const results = { success: 0, failed: 0 };
                
                for (let i = 0; i < list.length; i++) {
                    try {
                        log(`Deleting tweet ${i + 1}/${list.length}: ${list[i]}`);
                        
                        const r = await fetch(delEP, {
                            method: "POST",
                            headers: {
                                accept: "*/*", 
                                "content-type": "application/json", 
                                authorization: bearer,
                                "x-csrf-token": csrf, 
                                "x-client-transaction-id": delTid,
                                "x-twitter-active-user": "yes", 
                                "x-twitter-auth-type": "OAuth2Session",
                                "x-twitter-client-language": lang,
                                "sec-ch-ua": ua, 
                                "sec-ch-ua-mobile": "?0",
                                "sec-ch-ua-platform": "\"Windows\""
                            },
                            body: JSON.stringify({
                                variables: { tweet_id: list[i], dark_request: false },
                                queryId: "VaenaVgh5q5ih7kvyVjgtg"
                            }),
                            credentials: "include"
                        });
                        
                        if (r.status === 429) { 
                            log("Rate-limit hit, waiting 60 seconds..."); 
                            i--; // retry this tweet
                            await sleep(60000); 
                            continue; 
                        }
                        
                        if (!r.ok) {
                            const text = await r.text();
                            log(`Failed to delete tweet ${list[i]}, status: ${r.status}`, text);
                            results.failed++;
                        } else {
                            log(`Successfully deleted ${i + 1}/${list.length}`, list[i]);
                            results.success++;
                        }
                        
                        // Randomize delay 
                        const delay = 350 + Math.floor(Math.random() * 250);
                        await sleep(delay);
                    } catch (err) {
                        log(`Error deleting tweet ${list[i]}:`, err);
                        results.failed++;
                        await sleep(2000); 
                    }
                }
                
                return results;
            }

            try {
                log("Starting X Tweet Cleaner process...");
                
                const statusWindow = document.createElement("div");
                statusWindow.style.cssText = "position:fixed; top:10px; right:10px; padding:10px; " +
                    "background:rgba(0,0,0,0.8); color:white; z-index:9999; border-radius:5px; max-width:300px; font-size:12px;";
                document.body.appendChild(statusWindow);
                
                const updateStatus = (msg) => {
                    statusWindow.textContent = msg;
                    log(msg);
                };
                
                updateStatus("Finding tweets to delete...");
                
                const ids = (opts.ids && opts.ids.length) ? opts.ids : await harvest();
                
                if (!ids.length) {
                    updateStatus("No tweets found to delete");
                    setTimeout(() => statusWindow.remove(), 3000);
                    return alert("삭제 대상 없음");
                }
                
                updateStatus(`Found ${ids.length} tweets to delete. Starting deletion...`);
                
                const results = await nuke(ids);
                
                updateStatus(`Done! Deleted ${results.success} tweets. Failed: ${results.failed}`);
                setTimeout(() => statusWindow.remove(), 5000);
                
                alert(`Tweet Cleaner finished!\nDeleted: ${results.success}\nFailed: ${results.failed}`);
            } catch (e) {
                console.error(e);
                alert("Error: " + e.message);
            }
        });

    })();
}