const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const fs = require('fs');
const path = require('path');

const app = express();

// Kích hoạt middleware đọc dữ liệu JSON từ request body (Rất quan trọng cho API Webhook)
app.use(express.json());

const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// TÊN MIỀN CỐ ĐỊNH CỦA BẠN TRÊN CLOUDFLARE
const FIXED_DOMAIN = 'telegram-mini-app.ngogiaidy56.workers.dev';
const PORT = process.env.PORT || 8080;

const HTML_FILE_PATH = path.join(__dirname, 'index.html');
const JSON_FILE_PATH = path.join(__dirname, 'system_state.json');

let connectedClients = {}; 
let activeJobs = 0; 

// ==============================================================
// 🔄 HTML TĨNH TÍCH HỢP AJAX REAL-TIME TỰ ĐỘNG
// ==============================================================
function generateHTML() {
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
                .card { background: rgba(0,0,0,0.6); border: 1px solid #374151; padding: 15px; border-radius: 8px; border-left: 4px solid #3b82f6; transition: all 0.3s ease; }
                .card.edge { border-left-color: #10b981; }
                .card.queue { border-left-color: #8b5cf6; }
                .card h3 { margin: 0 0 10px 0; font-size: 14px; color: #d1d5db; text-transform: uppercase; }
                .value { font-size: 32px; font-weight: 700; color: #fff; text-shadow: 0 0 15px currentColor; transition: opacity 0.2s; }
                .text-blue { color: #60a5fa; } .text-green { color: #34d399; } .text-purple { color: #a78bfa; }
                .footer { margin-top: 25px; text-align: center; font-size: 12px; color: #6b7280; padding-top: 15px; border-top: 1px dashed #374151; }
                
                /* Hiệu ứng chớp nháy khi có dữ liệu mới */
                @keyframes flash { 0% { opacity: 0.5; } 100% { opacity: 1; } }
                .update-flash { animation: flash 0.5s ease-in-out; }
            </style>
        </head>
        <body>
            <div class="dashboard">
                <h1>VietSub Video Studio V3.0</h1>
                <div class="subtitle">Cloud-Native Core Backend & API Gateway</div>
                
                <div class="grid">
                    <div class="card edge">
                        <h3><span style="font-size:16px">⚡</span> Cloudflare Edge Nodes</h3>
                        <div class="value text-green" id="edgeNodeCount">0</div>
                    </div>
                    <div class="card">
                        <h3><span style="font-size:16px">📱</span> Connected Clients (Tier 1)</h3>
                        <div class="value text-blue" id="clientCount">0</div>
                    </div>
                    <div class="card queue">
                        <h3><span style="font-size:16px">🔄</span> Media Pipelines</h3>
                        <div class="value text-purple" id="pipelineCount">0 luồng</div>
                    </div>
                </div>

                <div class="footer">
                    Trạng thái: <span id="statusIndicator">🟢 Đang đồng bộ...</span> | Tên miền: ${FIXED_DOMAIN}
                </div>
            </div>

            <!-- Script tự động lấy dữ liệu không cần load lại trang -->
            <script>
                async function fetchSystemState() {
                    try {
                        const response = await fetch('/api/state');
                        if (!response.ok) throw new Error('Network err');
                        const data = await response.json();
                        
                        document.getElementById('edgeNodeCount').innerText = data.tier2_edgeNodes;
                        document.getElementById('clientCount').innerText = data.tier1_clients;
                        document.getElementById('pipelineCount').innerText = data.tier3_activePipelines.length + ' luồng';
                        document.getElementById('statusIndicator').innerText = '🟢 Đang hoạt động (Live)';
                        
                        // Thêm hiệu ứng chớp nhẹ khi cập nhật
                        document.querySelectorAll('.value').forEach(el => {
                            el.classList.remove('update-flash');
                            void el.offsetWidth; // trigger reflow
                            el.classList.add('update-flash');
                        });
                    } catch (error) {
                        document.getElementById('statusIndicator').innerText = '🔴 Mất kết nối Server';
                    }
                }

                // Gọi ngay lập tức và lặp lại mỗi 2 giây
                fetchSystemState();
                setInterval(fetchSystemState, 2000);
            </script>
        </body>
        </html>
    `;
}

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
// 🌐 REST API (DASHBOARD & WEBHOOK TỪ CLOUDFLARE WORKER)
// ==============================================================

// Render trang Dashboard
app.get('/', (req, res) => {
    res.send(generateHTML());
});

// Endpoint trả về dữ liệu thuần JSON để giao diện gọi 
app.get('/api/state', (req, res) => {
    const activeChannels = [...new Set(Object.values(connectedClients).map(t => t.channel))];
    const edgeNodeCount = Array.from(wss.clients).filter(c => c.isEdgeNode).length;
    
    res.json({
        tier1_clients: Object.keys(connectedClients).length,
        tier2_edgeNodes: edgeNodeCount,
        tier3_activePipelines: activeChannels,
        status: "ONLINE"
    });
});

// 🤖 API LẮNG NGHE LỆNH TỪ TELEGRAM BOT (CLOUDFLARE WORKER)
app.post('/api/bot-trigger', (req, res) => {
    const { chatId, userName, action } = req.body;

    if (action === 'START_VIETSUB_PIPELINE') {
        const jobId = 'BOT_JOB_' + chatId + '_' + Date.now();
        
        // Đưa Bot User vào danh sách Pipeline đang chạy để Dashboard cập nhật
        if (typeof connectedClients !== 'undefined') {
            connectedClients[jobId] = { 
                id: jobId, 
                channel: 'TELEGRAM-PIPELINE', 
                user: userName,
                status: 'WAITING_FOR_VIDEO'
            };
        }

        // Kích hoạt hàm xuất dữ liệu S.O.T ngay lập tức
        if (typeof autoExportData === 'function') {
            autoExportData();
        }

        console.log(`[TELEGRAM BOT] 🚀 User ${userName} vừa mở 1 luồng Vietsub Pipeline mới!`);
        
        // Trả về HTTP 200 để Cloudflare Worker không bị Timeout
        res.status(200).json({ success: true, message: "Đã kích hoạt Pipeline" });
    } else {
        res.status(400).json({ error: "Lệnh không xác định" });
    }
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
// ⚡ WEBSOCKET XỬ LÝ KẾT NỐI (CORE COMMUNICATION TIER)
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

            if (action === 'REGISTER_CLIENT_APP' || action === 'CLIENT_PING_RESPONSE') {
                if (data.value && data.value.id) {
                    ws.clientId = data.value.id; 
                    connectedClients[ws.clientId] = { ...data.value, channel: channel };
                    broadcastTabList(channel);
                    autoExportData();
                }
                return;
            }

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
    
    // Gán Domain cố định cho WebSocket và Web API
    const wsUrl = `wss://${FIXED_DOMAIN}`;
    const webUrl = `https://${FIXED_DOMAIN}`;
    
    console.clear();
    console.log("\x1b[36m============================================================================\x1b[0m");
    console.log(`\x1b[33m
    [ 3. CORE BACKEND TIER (NODE.JS) ]
    🛡️  API Gateway | Async Workers (BullMQ) | Real-time S.O.T
    \x1b[0m`);
    console.log("\x1b[36m============================================================================\x1b[0m");
    console.log(`\x1b[1m\x1b[32m✅ Hệ thống CORE BACKEND V3.0 Đã Sẵn Sàng!\x1b[0m`);
    console.log(`\x1b[1m\x1b[36m🌐 Bảng Điều Khiển Live:  \x1b[0m\x1b[4m${webUrl}\x1b[0m`);
    console.log(`\x1b[1m\x1b[35m⚡ Cổng WebSocket Node:   \x1b[0m\x1b[4m${wsUrl}\x1b[0m`);
    console.log(`\x1b[90m(Hỗ trợ xuất HTML chuẩn tĩnh, auto-fetch qua API ${webUrl}/api/state)\x1b[0m\n`);
});
