#!/bin/bash

echo "🚀 启动小鹅通调试服务器..."
echo ""

cd "$(dirname "$0")"

if [ ! -f "debug-server.js" ]; then
    echo "❌ 找不到 debug-server.js"
    exit 1
fi

echo "📡 启动服务器在端口 5031..."
node debug-server.js
