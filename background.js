// 小鹅通考试批量管理工具 - Background Service Worker

chrome.runtime.onInstalled.addListener(() => {
  console.log('小鹅通考试批量管理工具已安装');
});

// 监听来自content script的消息
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'getAccessToken') {
    // 从storage获取access token
    chrome.storage.local.get(['xiaoe_access_token'], (result) => {
      sendResponse({ token: result.xiaoe_access_token });
    });
    return true; // 保持消息通道开放
  }
  
  if (request.action === 'saveAccessToken') {
    chrome.storage.local.set({ xiaoe_access_token: request.token }, () => {
      sendResponse({ success: true });
    });
    return true;
  }
});