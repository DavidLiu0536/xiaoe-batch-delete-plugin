// 小鹅通考试批量管理工具 - Popup Script

document.addEventListener('DOMContentLoaded', () => {
  const statusDiv = document.getElementById('status');
  const openExamPageBtn = document.getElementById('openExamPage');
  const showHelpBtn = document.getElementById('showHelp');

  // 检查当前是否在小鹅通考试管理页面
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    const currentTab = tabs[0];
    if (currentTab.url && currentTab.url.includes('admin.xiaoe-tech.com/t/exam/examination')) {
      statusDiv.textContent = '✅ 已在小鹅通考试管理页面';
      statusDiv.style.background = '#e8f5e9';
      statusDiv.style.color = '#388e3c';
    } else {
      statusDiv.textContent = '⚠️ 请先打开小鹅通考试管理页面';
      statusDiv.style.background = '#fff3e0';
      statusDiv.style.color = '#f57c00';
    }
  });

  // 打开考试管理页面
  openExamPageBtn.addEventListener('click', () => {
    chrome.tabs.create({
      url: 'https://admin.xiaoe-tech.com/t/exam/examination#/examIndex/examList'
    });
  });

  // 显示使用说明
  showHelpBtn.addEventListener('click', () => {
    const helpText = `
使用说明：

1. 打开小鹅通考试管理页面
2. 页面会自动加载插件工具栏
3. 点击"检测重复考试"按钮
4. 查看重复考试检测结果
5. 选择要删除的副本
6. 点击"批量替换关联"替换课程关联
7. 点击"批量删除副本"删除选中的副本

注意事项：
- 删除操作不可恢复，请谨慎操作
- 建议先替换关联再删除副本
- 如遇问题请刷新页面重试
    `;
    alert(helpText);
  });
});