const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = 5031;
const DEBUG_FILE = path.join(__dirname, 'debug-data.json');
const CAPTURES_FILE = path.join(__dirname, 'api-captures.json');
const SCRIPT_FILE = path.join(__dirname, 'tampermonkey-script.js');

// 存储最新的调试信息
let latestDebugData = null;

// 创建HTTP服务器
const server = http.createServer((req, res) => {
    // 设置CORS头
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
        res.writeHead(200);
        res.end();
        return;
    }

    // 提供脚本文件（用于Tampermonkey自动更新）
    if (req.method === 'GET' && req.url === '/script.js') {
        try {
            const scriptContent = fs.readFileSync(SCRIPT_FILE, 'utf-8');
            res.writeHead(200, { 
                'Content-Type': 'application/javascript',
                'Cache-Control': 'no-cache, no-store, must-revalidate'
            });
            res.end(scriptContent);
            console.log('📜 脚本文件已提供给浏览器');
        } catch (error) {
            console.error('❌ 读取脚本文件失败:', error);
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: false, error: error.message }));
        }
        return;
    }

    // 接收脚本上报的接口签名（自动学习到的真实API端点）
    if (req.method === 'POST' && req.url === '/api/capture') {
        let body = '';
        req.on('data', chunk => { body += chunk.toString(); });
        req.on('end', () => {
            try {
                const entry = JSON.parse(body);
                let captures = [];
                try { captures = JSON.parse(fs.readFileSync(CAPTURES_FILE, 'utf-8')); } catch (e) {}
                const key = entry.method + ' ' + entry.url.split('?')[0];
                const existing = captures.findIndex(c => c.method + ' ' + c.url.split('?')[0] === key);
                if (existing === -1) {
                    captures.push({ ...entry, capturedAt: new Date().toISOString() });
                    fs.writeFileSync(CAPTURES_FILE, JSON.stringify(captures, null, 2));
                    console.log(`🎯 新接口签名: ${entry.method} ${entry.url.split('?')[0]}`);
                } else if (entry.headers && JSON.stringify(entry.headers) !== JSON.stringify(captures[existing].headers)) {
                    // 新捕获带了不同的headers → 更新（headers对写接口很关键）
                    captures[existing] = { ...entry, capturedAt: new Date().toISOString() };
                    fs.writeFileSync(CAPTURES_FILE, JSON.stringify(captures, null, 2));
                    console.log(`🔄 更新接口签名(含headers): ${entry.method} ${entry.url.split('?')[0]}`);
                }
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: true, total: captures.length }));
            } catch (error) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: false, error: error.message }));
            }
        });
        return;
    }

    // 查看已捕获的接口签名
    if (req.method === 'GET' && req.url === '/api/captures') {
        try {
            const captures = JSON.parse(fs.readFileSync(CAPTURES_FILE, 'utf-8'));
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(captures, null, 2));
        } catch (e) {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end('[]');
        }
        return;
    }

    if (req.method === 'POST' && req.url === '/api/debug') {
        let body = '';
        
        req.on('data', chunk => {
            body += chunk.toString();
        });
        
        req.on('end', () => {
            try {
                const data = JSON.parse(body);
                latestDebugData = data;
                
                // 保存到文件
                fs.writeFileSync(DEBUG_FILE, JSON.stringify(data, null, 2));
                
                console.log('✅ 收到调试信息:', new Date().toLocaleTimeString());
                console.log('📊 考试数量:', data.examList?.length || 0);
                console.log('📋 重复组数:', data.duplicates?.length || 0);
                
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: true, message: '调试信息已接收' }));
            } catch (error) {
                console.error('❌ 解析调试信息失败:', error);
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: false, error: error.message }));
            }
        });
    } else if (req.method === 'GET' && req.url === '/api/debug') {
        // 返回最新的调试信息
        if (latestDebugData) {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(latestDebugData));
        } else {
            res.writeHead(404, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: '暂无调试信息' }));
        }
    } else {
        res.writeHead(404);
        res.end('Not Found');
    }
});

server.listen(PORT, () => {
    console.log('🚀 调试服务器已启动');
    console.log(`📡 监听端口: http://localhost:${PORT}`);
    console.log(`📁 调试文件: ${DEBUG_FILE}`);
    console.log(`📜 脚本地址: http://localhost:${PORT}/script.js`);
    console.log('');
    console.log('⚙️ Tampermonkey自动更新配置:');
    console.log('   @updateURL    http://localhost:5031/script.js');
    console.log('   @downloadURL  http://localhost:5031/script.js');
    console.log('');
    console.log('等待脚本发送调试信息...');
    console.log('按 Ctrl+C 停止服务器');
});

// 优雅关闭
process.on('SIGINT', () => {
    console.log('\n🛑 服务器已停止');
    server.close();
    process.exit(0);
});
