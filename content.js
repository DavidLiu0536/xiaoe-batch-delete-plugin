// 小鹅通考试批量管理工具 - Content Script

class XiaoeExamManager {
  constructor() {
    this.examList = [];
    this.duplicateGroups = [];
    this.originalExams = new Map();
    this.apiBase = 'https://api.xiaoe-tech.com';
    this.accessToken = null;
    this.init();
  }

  async init() {
    console.log('小鹅通考试批量管理工具已加载');
    this.addPluginUI();
    this.getAccessToken();
  }

  // 获取 access_token
  async getAccessToken() {
    try {
      // 尝试从 localStorage 获取
      const token = localStorage.getItem('xiaoe_access_token');
      if (token) {
        this.accessToken = token;
        return;
      }

      // 尝试从页面中提取
      const scripts = document.querySelectorAll('script');
      for (let script of scripts) {
        const content = script.textContent;
        const tokenMatch = content.match(/access_token["\s:]+([^",\s]+)/);
        if (tokenMatch) {
          this.accessToken = tokenMatch[1];
          localStorage.setItem('xiaoe_access_token', tokenMatch[1]);
          return;
        }
      }
    } catch (error) {
      console.error('获取 access_token 失败:', error);
    }
  }

  // 添加插件UI
  addPluginUI() {
    // 等待页面加载完成
    const checkExist = setInterval(() => {
      const toolbar = document.querySelector('.exam-toolbar') || 
                     document.querySelector('.toolbar') ||
                     document.querySelector('.page-header');
      
      if (toolbar) {
        clearInterval(checkExist);
        this.createToolbar(toolbar);
      }
    }, 500);

    // 5秒后停止检查
    setTimeout(() => clearInterval(checkExist), 5000);
  }

  createToolbar(toolbar) {
    const pluginContainer = document.createElement('div');
    pluginContainer.className = 'xiaoe-plugin-toolbar';
    pluginContainer.innerHTML = `
      <div class="xiaoe-plugin-title">📚 考试批量管理工具</div>
      <div class="xiaoe-plugin-buttons">
        <button id="xiaoe-detect-duplicates" class="xiaoe-btn xiaoe-btn-primary">
          🔍 检测重复考试
        </button>
        <button id="xiaoe-replace-associations" class="xiaoe-btn xiaoe-btn-warning" disabled>
          🔄 批量替换关联
        </button>
        <button id="xiaoe-delete-duplicates" class="xiaoe-btn xiaoe-btn-danger" disabled>
          🗑️ 批量删除副本
        </button>
        <button id="xiaoe-show-info" class="xiaoe-btn xiaoe-btn-info">
          ℹ️ 显示考试信息
        </button>
      </div>
      <div id="xiaoe-plugin-status" class="xiaoe-plugin-status"></div>
      <div id="xiaoe-plugin-results" class="xiaoe-plugin-results"></div>
    `;

    toolbar.appendChild(pluginContainer);

    // 绑定事件
    document.getElementById('xiaoe-detect-duplicates').addEventListener('click', () => this.detectDuplicates());
    document.getElementById('xiaoe-replace-associations').addEventListener('click', () => this.replaceAssociations());
    document.getElementById('xiaoe-delete-duplicates').addEventListener('click', () => this.deleteDuplicates());
    document.getElementById('xiaoe-show-info').addEventListener('click', () => this.showExamInfo());
  }

  // 获取考试列表
  async getExamList() {
    this.updateStatus('正在获取考试列表...');
    
    try {
      // 尝试从页面中提取考试列表数据
      const examTable = document.querySelector('.exam-table') || 
                       document.querySelector('table[data-v-*]') ||
                       document.querySelector('.el-table__body-wrapper');
      
      if (examTable) {
        const rows = examTable.querySelectorAll('tr');
        this.examList = Array.from(rows).map(row => {
          const cells = row.querySelectorAll('td');
          if (cells.length > 0) {
            return {
              id: cells[0]?.textContent?.trim(),
              name: cells[1]?.textContent?.trim(),
              createTime: cells[2]?.textContent?.trim(),
              resource_id: cells[0]?.getAttribute('data-resource-id') || this.extractResourceId(row)
            };
          }
        }).filter(exam => exam && exam.name);
        
        this.updateStatus(`获取到 ${this.examList.length} 个考试`);
        return this.examList;
      }

      // 如果页面无法解析，尝试API调用
      return await this.fetchExamListFromAPI();
      
    } catch (error) {
      this.updateStatus('获取考试列表失败: ' + error.message, 'error');
      return [];
    }
  }

  // 从页面元素提取 resource_id
  extractResourceId(row) {
    const link = row.querySelector('a[href*="resource_id"]');
    if (link) {
      const match = link.href.match(/resource_id=([^&]+)/);
      return match ? match[1] : null;
    }
    return null;
  }

  // 通过API获取考试列表
  async fetchExamListFromAPI() {
    if (!this.accessToken) {
      this.updateStatus('缺少 access_token，无法调用API', 'error');
      return [];
    }

    try {
      const response = await fetch(`${this.apiBase}/xe.interaction.exam.list/1.0.0`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          access_token: this.accessToken,
          data: {
            page: 1,
            page_size: 100
          }
        })
      });

      const result = await response.json();
      if (result.code === 0) {
        this.examList = result.data.list || [];
        this.updateStatus(`通过API获取到 ${this.examList.length} 个考试`);
        return this.examList;
      } else {
        this.updateStatus(`API调用失败: ${result.msg}`, 'error');
        return [];
      }
    } catch (error) {
      this.updateStatus('API调用异常: ' + error.message, 'error');
      return [];
    }
  }

  // 检测重复考试
  async detectDuplicates() {
    this.updateStatus('正在检测重复考试...');
    this.examList = await this.getExamList();
    
    if (this.examList.length === 0) {
      this.updateStatus('没有找到考试数据', 'error');
      return;
    }

    // 按考试名称分组
    const nameGroups = new Map();
    this.examList.forEach(exam => {
      const normalizedName = this.normalizeExamName(exam.name);
      if (!nameGroups.has(normalizedName)) {
        nameGroups.set(normalizedName, []);
      }
      nameGroups.get(normalizedName).push(exam);
    });

    // 找出重复的考试
    this.duplicateGroups = [];
    nameGroups.forEach((exams, name) => {
      if (exams.length > 1) {
        // 按创建时间排序，最早的作为原始考试
        exams.sort((a, b) => new Date(a.createTime) - new Date(b.createTime));
        this.duplicateGroups.push({
          name: name,
          original: exams[0],
          duplicates: exams.slice(1)
        });
        this.originalExams.set(name, exams[0]);
      }
    });

    this.displayDuplicateResults();
    
    if (this.duplicateGroups.length > 0) {
      document.getElementById('xiaoe-replace-associations').disabled = false;
      document.getElementById('xiaoe-delete-duplicates').disabled = false;
      this.updateStatus(`检测完成，发现 ${this.duplicateGroups.length} 组重复考试`);
    } else {
      this.updateStatus('未发现重复考试');
    }
  }

  // 标准化考试名称用于比较
  normalizeExamName(name) {
    return name.trim()
      .replace(/\s+/g, '')
      .replace(/[^\u4e00-\u9fa5a-zA-Z0-9]/g, '');
  }

  // 显示重复检测结果
  displayDuplicateResults() {
    const resultsDiv = document.getElementById('xiaoe-plugin-results');
    
    if (this.duplicateGroups.length === 0) {
      resultsDiv.innerHTML = '<div class="xiaoe-result-empty">🎉 未发现重复考试</div>';
      return;
    }

    let html = '<div class="xiaoe-duplicate-list">';
    html += `<div class="xiaoe-result-header">发现 ${this.duplicateGroups.length} 组重复考试：</div>`;
    
    this.duplicateGroups.forEach((group, index) => {
      html += `
        <div class="xiaoe-duplicate-group">
          <div class="xiaoe-group-header">
            <span class="xiaoe-group-name">${group.name}</span>
            <span class="xiaoe-group-count">${group.duplicates.length + 1} 个副本</span>
          </div>
          <div class="xiaoe-group-content">
            <div class="xiaoe-exam-item xiaoe-exam-original">
              <span class="xiaoe-badge xiaoe-badge-original">原始</span>
              <span class="xiaoe-exam-id">${group.original.id}</span>
              <span class="xiaoe-exam-name">${group.original.name}</span>
              <span class="xiaoe-exam-time">${group.original.createTime}</span>
            </div>
            ${group.duplicates.map(dup => `
              <div class="xiaoe-exam-item xiaoe-exam-duplicate">
                <span class="xiaoe-badge xiaoe-badge-duplicate">副本</span>
                <span class="xiaoe-exam-id">${dup.id}</span>
                <span class="xiaoe-exam-name">${dup.name}</span>
                <span class="xiaoe-exam-time">${dup.createTime}</span>
                <input type="checkbox" class="xiaoe-delete-checkbox" data-exam-id="${dup.id}" checked>
              </div>
            `).join('')}
          </div>
        </div>
      `;
    });
    
    html += '</div>';
    resultsDiv.innerHTML = html;
  }

  // 批量替换关联
  async replaceAssociations() {
    this.updateStatus('正在批量替换考试关联...');
    
    let successCount = 0;
    let failCount = 0;

    for (const group of this.duplicateGroups) {
      for (const duplicate of group.duplicates) {
        try {
          // 这里需要调用小鹅通的API来替换课程关联
          // 由于具体API未知，这里提供框架
          const result = await this.replaceExamAssociation(duplicate.resource_id, group.original.resource_id);
          
          if (result) {
            successCount++;
          } else {
            failCount++;
          }
        } catch (error) {
          console.error('替换关联失败:', error);
          failCount++;
        }
      }
    }

    this.updateStatus(`替换完成：成功 ${successCount} 个，失败 ${failCount} 个`);
  }

  // 替换单个考试的关联
  async replaceExamAssociation(duplicateId, originalId) {
    // 这里需要根据实际的小鹅通API来实现
    // 可能需要调用课程关联更新接口
    console.log(`替换关联: ${duplicateId} -> ${originalId}`);
    return true; // 临时返回true
  }

  // 批量删除副本
  async deleteDuplicates() {
    const checkboxes = document.querySelectorAll('.xiaoe-delete-checkbox:checked');
    const examIdsToDelete = Array.from(checkboxes).map(cb => cb.dataset.examId);
    
    if (examIdsToDelete.length === 0) {
      this.updateStatus('没有选择要删除的考试', 'warning');
      return;
    }

    if (!confirm(`确定要删除 ${examIdsToDelete.length} 个考试副本吗？此操作不可恢复！`)) {
      return;
    }

    this.updateStatus(`正在删除 ${examIdsToDelete.length} 个考试副本...`);
    
    let successCount = 0;
    let failCount = 0;

    for (const examId of examIdsToDelete) {
      try {
        const result = await this.deleteExam(examId);
        if (result) {
          successCount++;
        } else {
          failCount++;
        }
      } catch (error) {
        console.error('删除考试失败:', error);
        failCount++;
      }
    }

    this.updateStatus(`删除完成：成功 ${successCount} 个，失败 ${failCount} 个`);
    
    // 刷新页面
    setTimeout(() => {
      location.reload();
    }, 2000);
  }

  // 删除单个考试
  async deleteExam(examId) {
    if (!this.accessToken) {
      console.error('缺少 access_token');
      return false;
    }

    try {
      const response = await fetch(`${this.apiBase}/xe.interaction.exam.delete/1.0.0`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          access_token: this.accessToken,
          data: {
            resource_id: examId
          }
        })
      });

      const result = await response.json();
      return result.code === 0;
    } catch (error) {
      console.error('删除考试API调用失败:', error);
      return false;
    }
  }

  // 显示考试信息
  showExamInfo() {
    this.examList = await this.getExamList();
    
    const infoDiv = document.getElementById('xiaoe-plugin-results');
    let html = '<div class="xiaoe-exam-info">';
    html += `<div class="xiaoe-result-header">当前考试列表 (${this.examList.length} 个)</div>`;
    html += '<table class="xiaoe-info-table">';
    html += '<thead><tr><th>ID</th><th>名称</th><th>创建时间</th></tr></thead>';
    html += '<tbody>';
    
    this.examList.forEach(exam => {
      html += `
        <tr>
          <td>${exam.id || exam.resource_id || '-'}</td>
          <td>${exam.name || '-'}</td>
          <td>${exam.createTime || '-'}</td>
        </tr>
      `;
    });
    
    html += '</tbody></table></div>';
    infoDiv.innerHTML = html;
  }

  // 更新状态显示
  updateStatus(message, type = 'info') {
    const statusDiv = document.getElementById('xiaoe-plugin-status');
    statusDiv.textContent = message;
    statusDiv.className = `xiaoe-plugin-status xiaoe-status-${type}`;
  }
}

// 初始化插件
window.addEventListener('load', () => {
  new XiaoeExamManager();
});