const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto'); // Chuẩn bị cho HMAC Edge Validation

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const PORT = process.env.PORT || 8080;

// Các tệp tĩnh xuất tự động (S.O.T)
const HTML_FILE_PATH = path.join(__dirname, 'index.html');
const JSON_FILE_PATH = path.join(__dirname, 'system_state.json');

// ==============================================================
// 🧠 TIER 3: RAM VĨNH CỬU & QUẢN LÝ TRẠNG THÁI (REDIS MOCKUP)
// ==============================================================
let connectedClients = {}; // Quản lý Web/Telegram/Native App
let activeJobs = 0; // Mô phỏng số lượng Job trong BullMQ

// Hàm tự động quét và lấy IP LAN (IPv4) của máy chủ hiện tại
function getNetworkIP() {
    const interfaces = os.networkInterfaces();
    for (const name of Object.keys(interfaces)) {
        for (const iface of interfaces[name]) {
            if (iface.family === 'IPv4' && !iface.internal) {
                return iface.address;
            }
        }
    }
    return '127.0.0.1';
}

// ==============================================================
// 🔄 HÀM TẠO GIAO DIỆN DASHBOARD (CHUẨN KIẾN TRÚC V3.0)
// ==============================================================
function generateHTML() {
    const activeChannels = [...new Set(Object.values(connectedClients).map(t => t.channel))];
    const edgeNodeCount = Array.from(wss.clients).filter(c => c.isEdgeNode).length; // Trạm mẹ đóng vai trò Edge
    const clientCount = Object.keys(connectedClients).length;

    return `
        <!DOCTYPE html>
        <html lang="vi">
        <head>
            <meta charset="UTF-8">
            <title>VietSub Studio V3.0 - Core Backend</title>
            <meta name="viewport" content="width=device-width, initial-scale=1">
            <style>
                @import url('https://fonts.googleapis.com/css2?family=Chakra+Petch:wght@400;600;700&display=swap');
                body { background: #030008; color: #00e5ff; font-family: 'Chakra Petch', sans-serif; padding: 30px; display: flex; justify-content: center; }
                .dashboard { border: 1px solid #1e3a8a; padding: 25px; border-radius: 12px; background: rgba(5, 10, 30, 0.85); box-shadow: 0 0 40px rgba(0, 112, 243, 0.2); max-width: 900px; width: 100%; backdrop-filter: blur(10px); }
                h1 { color: #facc15; font-size: 24px; text-align: center; text-transform: uppercase; margin-top: 0; letter-spacing: 1px; }
                .subtitle { text-align: center; color: #9ca3af; font-size: 13px; margin-bottom: 25px; }
                .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(250px, 1fr)); gap: 15px; }
                .card { background: rgba(0,0,0,0.6); border: 1px solid #374151; padding: 15px; border-radius: 8px; border-left: 4px solid #3b82f6; }
                .card.edge { border-left-color: #10b981; }
                .card.queue { border-left-color: #8b5cf6; }
                .card h3 { margin: 0 0 10px 0; font-size: 14px; color: #d1d5db; text-transform: uppercase; }
                .value { font-size: 32px; font-weight: 700; color: #fff; text-shadow: 0 0 15px currentColor; }
                .text-blue { color: #60a5fa; } .text-green { color: #34d399; } .text-purple { color: #a78bfa; }
                .footer { margin-top: 25px; text-align: center; font-size: 12px; color: #6b7280; padding-top: 15px; border-top: 1px dashed #374151; }
            </style>
        </head>
        <body>
            <div class="dashboard">
                <h1>VietSub Video Studio V3.0</h1>
                <div class="subtitle">Cloud-Native Core Backend & API Gateway</div>
                
                <div class="grid">
                    <div class="card edge">
                        <h3><span style="font-size:16px">⚡</span> Cloudflare Edge Nodes</h3>
                        <div class="value text-green">${edgeNodeCount}</div>
                    </div>
                    <div class="card">
                        <h3><span style="font-size:16px">📱</span> Connected Clients (Tier 1)</h3>
                        <div class="value text-blue">${clientCount}</div>
                    </div>
                    <div class="card queue">
                        <h3><span style="font-size:16px">🔄</span> Media Pipelines / BullMQ</h3>
                        <div class="value text-purple">${activeChannels.length} <span>luồng</span></div>
                    </div>
                </div>

                <div class="footer">
                    Trạng thái: 🟢 Đang hoạt động | Core Node.js | Single Source of Truth (S.O.T) Tích hợp | Cổng: ${PORT}
                </div>
            </div>
        </body>
        </html>
    `;
}

// Bóc tách tự động ra File khi có thay đổi trạng thái
function autoExportData() {
    try {
        fs.writeFileSync(HTML_FILE_PATH, generateHTML(), 'utf8');
        
        const activeChannels = [...new Set(Object.values(connectedClients).map(t => t.channel))];
        const edgeNodeCount = Array.from(wss.clients).filter(c => c.isEdgeNode).length;
        
        const systemState = {
            tier1_clients: Object.keys(connectedClients).length,
            tier2_edgeNodes: edgeNodeCount,
            tier3_activePipelines: activeChannels,
            status: "ONLINE",
            timestamp: new Date().toISOString()
        };
        fs.writeFileSync(JSON_FILE_PATH, JSON.stringify(systemState, null, 2), 'utf8');
    } catch (err) {
        console.error('[S.O.T EXPORT ERROR]:', err.message);
    }
}

// ==============================================================
// 🌐 API GATEWAY (TIER 3)
// ==============================================================
app.get('/', (req, res) => {
    res.send(generateHTML());
});

function broadcastTabList(channel) {
    const clientsInChannel = Object.values(connectedClients).filter(t => t.channel === channel);
    const payload = JSON.stringify({ action: 'SYNC_CLIENT_LIST', value: clientsInChannel, channel: channel });
    
    wss.clients.forEach(client => {
        if (client.readyState === WebSocket.OPEN && client.isEdgeNode && client.channel === channel) {
            client.send(payload);
        }
    });
}

// ==============================================================
// ⚡ WEBSOCKET BẤT ĐỒNG BỘ
// ==============================================================
wss.on('connection', (ws) => {
    ws.isAlive = true;
    ws.channel = 'GLOBAL-PIPELINE'; 
    ws.isEdgeNode = false;

    autoExportData();

    ws.on('pong', () => { ws.isAlive = true; });

    ws.on('message', (message) => {
        try {
            const data = JSON.parse(message);
            const action = data.action;
            const channel = data.channel || ws.channel || 'GLOBAL-PIPELINE';
            ws.channel = channel; 

            // Xác định đây là Edge Node (Trạm Mẹ) hoặc Worker CF gọi về
            if (action === 'EDGE_PING_REQUEST' || action === 'REGISTER_EDGE_NODE') {
                if (!ws.isEdgeNode) {
                    ws.isEdgeNode = true;
                    autoExportData();
                }
                const clientsInChannel = Object.values(connectedClients).filter(t => t.channel === channel);
                ws.send(JSON.stringify({ action: 'SYNC_CLIENT_LIST', value: clientsInChannel, channel: channel }));
                
                if (action === 'EDGE_PING_REQUEST') {
                    wss.clients.forEach((client) => {
                        if (client !== ws && client.readyState === WebSocket.OPEN && client.channel === channel) {
                            client.send(message.toString());
                        }
                    });
                }
                return;
            }

            // Đăng ký Client (Telegram App, Native App, PWA)
            if (action === 'REGISTER_CLIENT_APP' || action === 'CLIENT_PING_RESPONSE') {
                if (data.value && data.value.id) {
                    ws.clientId = data.value.id; 
                    connectedClients[ws.clientId] = { ...data.value, channel: channel };
                    broadcastTabList(channel);
                    autoExportData();
                }
                return;
            }

            // Định tuyến thông điệp trong cùng Pipeline
            wss.clients.forEach((client) => {
                if (client !== ws && client.readyState === WebSocket.OPEN && client.channel === channel) {
                    client.send(message.toString());
                }
            });

        } catch (err) { }
    });

    ws.on('close', () => {
        let hasChanges = false;
        if (ws.clientId && connectedClients[ws.clientId]) {
            const ch = connectedClients[ws.clientId].channel; 
            delete connectedClients[ws.clientId]; 
            broadcastTabList(ch);
            hasChanges = true;
        }
        if (ws.isEdgeNode) hasChanges = true;
        if (hasChanges) autoExportData(); 
    });
});

// Giữ kết nối & Dọn dẹp
const interval = setInterval(() => {
    let hasChanges = false;
    wss.clients.forEach((ws) => {
        if (ws.isAlive === false) {
            if (ws.clientId && connectedClients[ws.clientId]) {
                const ch = connectedClients[ws.clientId].channel;
                delete connectedClients[ws.clientId];
                broadcastTabList(ch); 
                hasChanges = true;
            }
            if (ws.isEdgeNode) hasChanges = true;
            return ws.terminate();
        }
        ws.isAlive = false;
        ws.ping();
    });
    if (hasChanges) autoExportData(); 
}, 15000); 

wss.on('close', () => clearInterval(interval));

// ==============================================================
// 🚀 KHỞI ĐỘNG HỆ THỐNG
// ==============================================================
server.listen(PORT, () => {
    autoExportData();
    
    // Tự động gán Domain hoặc IP LAN với Port linh hoạt
    const PUBLIC_HOST = process.env.PUBLIC_HOST || getNetworkIP(); 
    const wsUrl = `ws://${PUBLIC_HOST}:${PORT}`;
    const webUrl = `http://${PUBLIC_HOST}:${PORT}`;
    
    console.clear();
    console.log("\x1b[36m============================================================================\x1b[0m");
    console.log(`\x1b[33m
    [ 3. CORE BACKEND TIER (NODE.JS) ]
    🛡️  API Gateway | Async Workers (BullMQ) | Redis Config
    \x1b[0m`);
    console.log("\x1b[36m============================================================================\x1b[0m");
    console.log(`\x1b[1m\x1b[32m✅ Hệ thống CORE BACKEND V3.0 Đã Sẵn Sàng!\x1b[0m`);
    console.log(`\x1b[1m\x1b[36m🌐 Bảng Điều Khiển:       \x1b[0m\x1b[4m${webUrl}\x1b[0m`);
    console.log(`\x1b[1m\x1b[35m⚡ Cổng WebSocket Node:   \x1b[0m\x1b[4m${wsUrl}\x1b[0m`);
    console.log(`\x1b[90m(Ghi chú: HTML & JSON được bóc tách tự động ra S.O.T Storage mỗi khi có sự kiện)\x1b[0m\n`);
});
