/**
 * 小鹅通考试批量管理工具 - 控制台脚本版本
 * 使用方法：
 * 1. 打开小鹅通考试管理页面
 * 2. 按F12打开浏览器控制台
 * 3. 粘贴此脚本并回车运行
 */

class XiaoeExamManager {
  constructor() {
    this.examList = [];
    this.duplicateGroups = [];
    this.originalExams = new Map();
    this.apiBase = 'https://api.xiaoe-tech.com';
    this.accessToken = null;
    console.log('📚 小鹅通考试批量管理工具已加载');
    console.log('🔧 使用 help() 查看使用说明');
  }

  // 帮助信息
  help() {
    console.log(`
📚 小鹅通考试批量管理工具 - 使用说明

🔍 detectDuplicates()    - 检测重复考试
🔄 replaceAssociations()  - 批量替换关联  
🗑️ deleteDuplicates()     - 批量删除副本
ℹ️ showExamInfo()         - 显示考试信息
🔧 help()                 - 显示此帮助信息

📝 使用流程：
1. 先运行 detectDuplicates() 检测重复
2. 查看检测结果，确认要删除的副本
3. 运行 replaceAssociations() 替换关联
4. 运行 deleteDuplicates() 删除副本

⚠️ 注意事项：
- 删除操作不可恢复，请谨慎操作
- 建议先替换关联再删除副本
- 如遇问题请刷新页面重试
    `);
  }

  // 获取 access_token
  async getAccessToken() {
    try {
      // 尝试从 localStorage 获取
      const token = localStorage.getItem('xiaoe_access_token');
      if (token) {
        this.accessToken = token;
        console.log('✅ 从 localStorage 获取到 access_token');
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
          console.log('✅ 从页面提取到 access_token');
          return;
        }
      }

      // 尝试从 cookie 获取
      const cookies = document.cookie;
      const tokenMatch = cookies.match(/access_token=([^;]+)/);
      if (tokenMatch) {
        this.accessToken = decodeURIComponent(tokenMatch[1]);
        console.log('✅ 从 cookie 获取到 access_token');
        return;
      }

      console.warn('⚠️ 无法自动获取 access_token，请手动设置:');
      console.log('manager.setAccessToken("your_token_here")');
    } catch (error) {
      console.error('❌ 获取 access_token 失败:', error);
    }
  }

  // 手动设置 access_token
  setAccessToken(token) {
    this.accessToken = token;
    localStorage.setItem('xiaoe_access_token', token);
    console.log('✅ access_token 已设置');
  }

  // 获取考试列表
  async getExamList() {
    console.log('🔍 正在获取考试列表...');
    
    try {
      // 尝试从页面中提取考试列表数据
      const examTable = document.querySelector('.exam-table') || 
                       document.querySelector('table') ||
                       document.querySelector('.el-table__body-wrapper');
      
      if (examTable) {
        const rows = examTable.querySelectorAll('tr');
        this.examList = Array.from(rows).map((row, index) => {
          const cells = row.querySelectorAll('td');
          if (cells.length > 0) {
            return {
              index: index,
              id: cells[0]?.textContent?.trim(),
              name: cells[1]?.textContent?.trim(),
              createTime: cells[2]?.textContent?.trim(),
              resource_id: this.extractResourceId(row)
            };
          }
        }).filter(exam => exam && exam.name);
        
        console.log(`✅ 从页面获取到 ${this.examList.length} 个考试`);
        return this.examList;
      }

      // 尝试从Vue实例获取数据
      const vueApp = document.querySelector('#app').__vue__;
      if (vueApp && vueApp.$data) {
        console.log('🔍 尝试从Vue实例获取数据...');
        // 这里需要根据实际的Vue数据结构来调整
      }

      // 如果页面无法解析，提示用户
      console.warn('⚠️ 无法从页面解析考试列表，请提供页面结构信息');
      return [];
      
    } catch (error) {
      console.error('❌ 获取考试列表失败:', error);
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
    
    // 尝试从 data 属性获取
    const resourceId = row.getAttribute('data-resource-id');
    if (resourceId) return resourceId;
    
    // 尝试从点击事件获取
    const clickHandler = row.getAttribute('onclick');
    if (clickHandler) {
      const match = clickHandler.match(/resource_id["\s:]+([^",\s]+)/);
      return match ? match[1] : null;
    }
    
    return null;
  }

  // 检测重复考试
  async detectDuplicates() {
    console.log('🔍 正在检测重复考试...');
    await this.getAccessToken();
    this.examList = await this.getExamList();
    
    if (this.examList.length === 0) {
      console.warn('⚠️ 没有找到考试数据');
      return;
    }

    console.log(`📊 分析 ${this.examList.length} 个考试...`);

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
        exams.sort((a, b) => {
          const timeA = new Date(a.createTime || 0);
          const timeB = new Date(b.createTime || 0);
          return timeA - timeB;
        });
        
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
      console.log(`✅ 检测完成，发现 ${this.duplicateGroups.length} 组重复考试`);
      console.log('💡 使用 showDuplicateDetails() 查看详细信息');
    } else {
      console.log('🎉 未发现重复考试');
    }
  }

  // 标准化考试名称用于比较
  normalizeExamName(name) {
    if (!name) return '';
    return name.trim()
      .replace(/\s+/g, '')
      .replace(/[^\u4e00-\u9fa5a-zA-Z0-9]/g, '');
  }

  // 显示重复检测结果
  displayDuplicateResults() {
    if (this.duplicateGroups.length === 0) {
      console.log('🎉 未发现重复考试');
      return;
    }

    console.log(`\n📋 发现 ${this.duplicateGroups.length} 组重复考试：\n`);
    
    this.duplicateGroups.forEach((group, index) => {
      console.log(`🔸 第 ${index + 1} 组: ${group.name}`);
      console.log(`   原始考试: ${group.original.name} (${group.original.id})`);
      console.log(`   副本数量: ${group.duplicates.length} 个`);
      group.duplicates.forEach((dup, i) => {
        console.log(`   ${i + 1}. ${dup.name} (${dup.id})`);
      });
      console.log('');
    });
  }

  // 显示详细重复信息
  showDuplicateDetails() {
    if (this.duplicateGroups.length === 0) {
      console.warn('⚠️ 请先运行 detectDuplicates()');
      return;
    }

    console.log('\n📋 重复考试详细信息：\n');
    console.table(this.duplicateGroups.map((group, index) => ({
      '组号': index + 1,
      '考试名称': group.name,
      '原始ID': group.original.id,
      '原始名称': group.original.name,
      '副本数量': group.duplicates.length,
      '副本ID列表': group.duplicates.map(d => d.id).join(', ')
    })));
  }

  // 批量替换关联
  async replaceAssociations() {
    if (this.duplicateGroups.length === 0) {
      console.warn('⚠️ 请先运行 detectDuplicates()');
      return;
    }

    console.log('🔄 正在批量替换考试关联...');
    
    let successCount = 0;
    let failCount = 0;

    for (const group of this.duplicateGroups) {
      for (const duplicate of group.duplicates) {
        try {
          console.log(`🔄 替换: ${duplicate.name} -> ${group.original.name}`);
          
          // 这里需要调用小鹅通的API来替换课程关联
          const result = await this.replaceExamAssociation(duplicate.resource_id, group.original.resource_id);
          
          if (result) {
            successCount++;
            console.log(`✅ 替换成功: ${duplicate.name}`);
          } else {
            failCount++;
            console.log(`❌ 替换失败: ${duplicate.name}`);
          }
        } catch (error) {
          console.error(`❌ 替换异常: ${duplicate.name}`, error);
          failCount++;
        }
      }
    }

    console.log(`\n📊 替换完成：成功 ${successCount} 个，失败 ${failCount} 个`);
  }

  // 替换单个考试的关联
  async replaceExamAssociation(duplicateId, originalId) {
    // 这里需要根据实际的小鹅通API来实现
    // 可能需要调用课程关联更新接口
    console.log(`📝 API调用: 替换关联 ${duplicateId} -> ${originalId}`);
    console.log('⚠️ 此功能需要根据实际API接口实现');
    return false; // 临时返回false，需要实现具体API调用
  }

  // 批量删除副本
  async deleteDuplicates() {
    if (this.duplicateGroups.length === 0) {
      console.warn('⚠️ 请先运行 detectDuplicates()');
      return;
    }

    // 收集所有副本ID
    const duplicateIds = [];
    this.duplicateGroups.forEach(group => {
      group.duplicates.forEach(dup => {
        duplicateIds.push({
          id: dup.id,
          name: dup.name,
          resource_id: dup.resource_id
        });
      });
    });

    if (duplicateIds.length === 0) {
      console.warn('⚠️ 没有要删除的副本');
      return;
    }

    console.log(`⚠️ 即将删除 ${duplicateIds.length} 个考试副本：`);
    duplicateIds.forEach((dup, index) => {
      console.log(`${index + 1}. ${dup.name} (${dup.id})`);
    });

    const confirm = prompt(`请输入 "DELETE" 确认删除 ${duplicateIds.length} 个考试副本：`);
    if (confirm !== 'DELETE') {
      console.log('❌ 取消删除操作');
      return;
    }

    console.log('🗑️ 正在删除考试副本...');
    
    let successCount = 0;
    let failCount = 0;

    for (const exam of duplicateIds) {
      try {
        console.log(`🗑️ 删除: ${exam.name}`);
        const result = await this.deleteExam(exam.resource_id);
        
        if (result) {
          successCount++;
          console.log(`✅ 删除成功: ${exam.name}`);
        } else {
          failCount++;
          console.log(`❌ 删除失败: ${exam.name}`);
        }
      } catch (error) {
        console.error(`❌ 删除异常: ${exam.name}`, error);
        failCount++;
      }
    }

    console.log(`\n📊 删除完成：成功 ${successCount} 个，失败 ${failCount} 个`);
    console.log('💡 建议刷新页面查看结果');
  }

  // 删除单个考试
  async deleteExam(examId) {
    if (!this.accessToken) {
      console.error('❌ 缺少 access_token');
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
      console.log(`📡 API响应:`, result);
      return result.code === 0;
    } catch (error) {
      console.error('❌ 删除考试API调用失败:', error);
      return false;
    }
  }

  // 显示考试信息
  async showExamInfo() {
    console.log('🔍 正在获取考试信息...');
    this.examList = await this.getExamList();
    
    if (this.examList.length === 0) {
      console.warn('⚠️ 没有找到考试数据');
      return;
    }

    console.log(`\n📋 当前考试列表 (${this.examList.length} 个)：\n`);
    console.table(this.examList.map(exam => ({
      'ID': exam.id || exam.resource_id || '-',
      '名称': exam.name || '-',
      '创建时间': exam.createTime || '-'
    })));
  }

  // 手动添加考试数据（用于测试）
  addExamData(exams) {
    this.examList = exams;
    console.log(`✅ 手动添加了 ${exams.length} 个考试数据`);
  }
}

// 初始化管理器
const manager = new XiaoeExamManager();

// 显示欢迎信息
console.log('🎉 小鹅通考试批量管理工具已就绪！');
console.log('🔧 输入 help() 查看使用说明');