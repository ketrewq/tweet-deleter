document.addEventListener('DOMContentLoaded', () => {
  const cleanBtn = document.getElementById('cleanBtn');
  const statusText = document.getElementById('status');
  const debugMode = document.getElementById('debugMode');

  // 탭 전환 로직 (CSP 준수를 위해 inline 스크립트 대신 여기에 구현)
  document.querySelectorAll('.tab').forEach(tab => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
      tab.classList.add('active');

      const tabId = tab.getAttribute('data-tab');
      document.querySelectorAll('.tab-content').forEach(content => content.classList.remove('active'));
      document.getElementById(tabId)?.classList.add('active');
    });
  });
  
  const showStatus = (msg, isError = false) => {
    statusText.textContent = msg;
    statusText.classList.toggle('error', isError);
    statusText.style.display = 'block';
  };

  const getOptions = () => {
    return {
      unretweet: document.getElementById('unretweet').checked,
      keepPin: document.getElementById('keepPin').checked,
      linkOnly: document.getElementById('linkOnly').checked,
      keywords: document.getElementById('keywords').value
        ? document.getElementById('keywords').value.split(',').map(s => s.trim())
        : [],
      ignore: document.getElementById('ignore').value
        ? document.getElementById('ignore').value.split(',').map(s => s.trim())
        : [],
      after: document.getElementById('after').value || null,
      before: document.getElementById('before').value || null,
      debug: document.getElementById('debugMode')?.checked || false
    };
  };

  cleanBtn.addEventListener('click', async () => {
    showStatus("작업 중...");

    try {
      const opts = getOptions();
      await chrome.storage.local.set({ opts });

      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tab) throw new Error("활성 탭을 찾을 수 없습니다.");

      if (!tab.url.includes('x.com') && !tab.url.includes('twitter.com')) {
        throw new Error("먼저 X.com에 접속해주세요.");
      }

      const credentials = await chrome.storage.local.get(['bearer', 'timelineCTID', 'tweetsQry', 'tweetsQS']);
      const hasAuth = credentials.bearer && credentials.timelineCTID && credentials.tweetsQry;
      
      if (!hasAuth) {
        showStatus("API 인증 정보가 없습니다. X.com 프로필 페이지에서 스크롤 후 재시도해주세요.", true);
        return;
      }

      const response = await chrome.runtime.sendMessage({
        cmd: "inject-cleaner",
        tabId: tab.id
      });

      if (!response.ok) {
        throw new Error(response.err || "스크립트 삽입 실패");
      }

      showStatus("실행 중! 탭을 유지하세요. 완료 후 알림이 표시됩니다.");
    } catch (err) {
      showStatus("오류: " + err.message, true);
      console.error(err);
    }
  });

  document.getElementById('refreshAuth')?.addEventListener('click', async () => {
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      
      if (!tab.url.includes('x.com') && !tab.url.includes('twitter.com')) {
        throw new Error("X.com에 접속한 상태에서만 가능합니다");
      }
      
      await chrome.tabs.reload(tab.id);
      showStatus("페이지를 다시 로드했습니다. 몇 초 후 다시 시도하세요.");
    } catch (err) {
      showStatus("오류: " + err.message, true);
    }
  });

  chrome.storage.local.get('opts', ({ opts }) => {
    if (!opts) return;
    document.getElementById('unretweet').checked = opts.unretweet !== false;
    document.getElementById('keepPin').checked = opts.keepPin !== false;
    document.getElementById('linkOnly').checked = opts.linkOnly === true;
    if (document.getElementById('debugMode')) {
      document.getElementById('debugMode').checked = opts.debug === true;
    }
    if (opts.keywords?.length)
      document.getElementById('keywords').value = opts.keywords.join(', ');
    if (opts.ignore?.length)
      document.getElementById('ignore').value = opts.ignore.join(', ');
    if (opts.after)
      document.getElementById('after').value = opts.after;
    if (opts.before)
      document.getElementById('before').value = opts.before;
  });

  function updateAuthStatus() {
    chrome.storage.local.get(['bearer', 'timelineCTID', 'tweetsQry'], (data) => {
      const hasAuth = data.bearer && data.timelineCTID && data.tweetsQry;
      const authStatus = document.getElementById('authStatus');
      
      if (authStatus) {
        authStatus.textContent = hasAuth
          ? "✓ API 인증 정보 확보됨"
          : "⚠ X.com에서 reply탭을 스크롤해 주세요.";
        authStatus.style.color = hasAuth ? "green" : "orange";
      } else {
        const newAuthStatus = document.createElement('div');
        newAuthStatus.id = 'authStatus';
        newAuthStatus.textContent = hasAuth
          ? "✓ API 인증 정보 확보됨"
          : "⚠ X.com에서 reply탭을 스크롤해 주세요.";
        newAuthStatus.style.color = hasAuth ? "green" : "orange";
        newAuthStatus.style.marginTop = "12px";
        document.querySelector('.container').appendChild(newAuthStatus);
      }
    });
  }
  
  updateAuthStatus();
  
  setInterval(updateAuthStatus, 5000);
});
