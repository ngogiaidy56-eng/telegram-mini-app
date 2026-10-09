const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const fs = require('fs');
const path = require('path');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const PORT = process.env.PORT || 8080;

// Đường dẫn file tự động trích xuất
const HTML_FILE_PATH = path.join(__dirname, 'index.html');
const JSON_FILE_PATH = path.join(__dirname, 'file.json');

// ==============================================================
// 🧠 CỤC RAM VĨNH CỬU (ĐÃ NÂNG CẤP CHIA LUỒNG)
// ==============================================================
let connectedTabs = {}; 

// ==============================================================
// 🔄 HÀM TẠO GIAO DIỆN & TỰ ĐỘNG XUẤT FILE
// ==============================================================
function generateHTML() {
    const activeChannels = [...new Set(Object.values(connectedTabs).map(t => t.channel))];
    const masterCount = Array.from(wss.clients).filter(c => c.isMaster).length;

    return `
        <!DOCTYPE html>
        <html>
        <head>
            <title>TRẠM VŨ TRỤ HENDY 5.2</title>
            <meta name="viewport" content="width=device-width, initial-scale=1">
            <style>
                @import url('https://fonts.googleapis.com/css2?family=Chakra+Petch:wght@400;700&display=swap');
                body { background: #050208; color: #00e5ff; font-family: 'Chakra Petch', sans-serif; text-align: center; padding-top: 50px; }
                .box { border: 2px solid #c840ff; padding: 30px; border-radius: 10px; display: inline-block; box-shadow: 0 0 30px rgba(200,64,255,0.4); background: rgba(10,4,16,0.9); min-width: 400px; }
                h1 { color: #ffcc00; text-shadow: 0 0 10px rgba(255,204,0,0.5); font-size: 28px; margin-top: 0;}
                .status { font-size: 18px; font-weight: bold; margin: 15px 0; border-bottom: 1px dashed #333; padding-bottom: 10px;}
                .online { color: #00ffcc; text-shadow: 0 0 10px rgba(0,255,204,0.5); }
                .count { font-size: 50px; color: #fff; margin: 10px 0; font-weight: bold; text-shadow: 0 0 20px #00e5ff;}
                .stat-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 15px; margin-top: 20px;}
                .stat-box { background: #000; border: 1px solid #555; padding: 15px; border-radius: 8px; }
            </style>
        </head>
        <body>
            <div class="box">
                <h1>🚀 TỔNG ĐÀI HENDY CYBERPUNK 5.2 🚀</h1>
                
                <div class="status">Trạm Mẹ (Master) Online: <span class="online">${masterCount}</span></div>
                
                <div class="stat-grid">
                    <div class="stat-box">
                        <div style="color: #aaa; font-size: 14px;">Đàn Em Đang Sống</div>
                        <div class="count">${Object.keys(connectedTabs).length}</div>
                    </div>
                    <div class="stat-box" style="border-color: #ffcc00;">
                        <div style="color: #ffcc00; font-size: 14px;">Luồng (Channel) Kích Hoạt</div>
                        <div class="count" style="color:#ffcc00; text-shadow: 0 0 20px #ffcc00;">${activeChannels.length}</div>
                    </div>
                </div>

                <div style="color: #555; font-size: 12px; margin-top: 25px;">Trạng thái Server: BẤT TỬ | Cổng: ${PORT}</div>
            </div>
        </body>
        </html>
    `;
}

function autoExportData() {
    try {
        // 1. Xuất file index.html
        fs.writeFileSync(HTML_FILE_PATH, generateHTML(), 'utf8');
        
        // 2. Xuất file dữ liệu file.json
        const activeChannels = [...new Set(Object.values(connectedTabs).map(t => t.channel))];
        const masterCount = Array.from(wss.clients).filter(c => c.isMaster).length;
        const jsonData = {
            masterCount,
            slaveCount: Object.keys(connectedTabs).length,
            activeChannels,
            timestamp: new Date().toLocaleString('vi-VN')
        };
        fs.writeFileSync(JSON_FILE_PATH, JSON.stringify(jsonData, null, 2), 'utf8');
    } catch (err) {
        console.error('[LỖI XUẤT FILE]:', err.message);
    }
}

// ==============================================================
// 🌐 GIAO DIỆN GIÁM SÁT TRÊN TRÌNH DUYỆT (DASHBOARD)
// ==============================================================
app.get('/', (req, res) => {
    res.send(generateHTML());
});

function broadcastTabList(channel) {
    const tabsInChannel = Object.values(connectedTabs).filter(t => t.channel === channel);
    const payload = JSON.stringify({ action: 'SYNC_TAB_LIST', value: tabsInChannel, channel: channel });
    
    wss.clients.forEach(client => {
        if (client.readyState === WebSocket.OPEN && client.isMaster && client.channel === channel) {
            client.send(payload);
        }
    });
}

// ==============================================================
// ⚡ XỬ LÝ GIAO TIẾP WEBSOCKET (ĐÃ FIX PHÂN LUỒNG)
// ==============================================================
wss.on('connection', (ws) => {
    ws.isAlive = true;
    ws.channel = 'KENH-1'; 
    ws.isMaster = false;

    // Kích hoạt xuất file khi có thiết bị mới kết nối
    autoExportData();

    ws.on('pong', () => { ws.isAlive = true; });

    ws.on('message', (message) => {
        try {
            const data = JSON.parse(message);
            const action = data.action;
            
            const channel = data.channel || ws.channel || 'KENH-1';
            ws.channel = channel; 

            if (action === 'SYNC_PING_REQUEST' || action === 'SYNC_REGISTER_MASTER') {
                if (!ws.isMaster) {
                    ws.isMaster = true;
                    autoExportData(); // Xuất file khi số lượng Trạm Mẹ thay đổi
                }
                
                const tabsInChannel = Object.values(connectedTabs).filter(t => t.channel === channel);
                ws.send(JSON.stringify({ action: 'SYNC_TAB_LIST', value: tabsInChannel, channel: channel }));
                
                if (action === 'SYNC_PING_REQUEST') {
                    wss.clients.forEach((client) => {
                        if (client !== ws && client.readyState === WebSocket.OPEN && client.channel === channel) {
                            client.send(message.toString());
                        }
                    });
                }
                return;
            }

            if (action === 'SYNC_REGISTER_TAB' || action === 'SYNC_PING_RESPONSE') {
                if (data.value && data.value.id) {
                    ws.slaveId = data.value.id; 
                    connectedTabs[ws.slaveId] = { ...data.value, channel: channel };
                    
                    broadcastTabList(channel);
                    autoExportData(); // Xuất file khi có Đàn Em mới
                }
                return;
            }

            if (action === 'SYNC_REQUEST_TAB_LIST') {
                const tabsInChannel = Object.values(connectedTabs).filter(t => t.channel === channel);
                ws.send(JSON.stringify({ action: 'SYNC_TAB_LIST', value: tabsInChannel, channel: channel }));
                return;
            }

            wss.clients.forEach((client) => {
                if (client !== ws && client.readyState === WebSocket.OPEN && client.channel === channel) {
                    client.send(message.toString());
                }
            });

        } catch (err) {
            // Im lặng bỏ qua rác
        }
    });

    ws.on('close', () => {
        let hasChanges = false;
        if (ws.slaveId && connectedTabs[ws.slaveId]) {
            const ch = connectedTabs[ws.slaveId].channel; 
            delete connectedTabs[ws.slaveId]; 
            broadcastTabList(ch);
            hasChanges = true;
        }
        if (ws.isMaster) {
            hasChanges = true;
        }
        
        if (hasChanges) autoExportData(); // Xuất file khi có thiết bị rớt mạng
    });
});

// ==============================================================
// 💓 NHỊP TIM BẢO VỆ MẠNG (TỰ ĐỘNG XÓA XÁC CHẾT KHỎI RAM)
// ==============================================================
const interval = setInterval(() => {
    let hasChanges = false;
    wss.clients.forEach((ws) => {
        if (ws.isAlive === false) {
            if (ws.slaveId && connectedTabs[ws.slaveId]) {
                const ch = connectedTabs[ws.slaveId].channel;
                delete connectedTabs[ws.slaveId];
                broadcastTabList(ch); 
                hasChanges = true;
            }
            if (ws.isMaster) hasChanges = true;
            return ws.terminate();
        }
        ws.isAlive = false;
        ws.ping();
    });
    
    if (hasChanges) autoExportData(); // Cập nhật file nếu có xóa thiết bị
}, 15000); 

wss.on('close', () => clearInterval(interval));

// ==============================================================
// 🚀 KHỞI ĐỘNG ĐỘNG CƠ
// ==============================================================
server.listen(PORT, () => {
    // Gọi xuất file lần đầu tiên khi bật Server
    autoExportData();
    
    console.clear();
    console.log("\x1b[36m============================================================================\x1b[0m");
    console.log(`
   ██╗  ██╗███████╗███╗   ██╗██████╗ ██╗   ██╗
   ██║  ██║██╔════╝████╗  ██║██╔══██╗╚██╗ ██╔╝
   ███████║█████╗  ██╔██╗ ██║██║  ██║ ╚████╔╝ 
   ██╔══██║██╔══╝  ██║╚██╗██║██║  ██║  ╚██╔╝  
   ██║  ██║███████╗██║ ╚████║██████╔╝   ██║   
   ╚═╝  ╚═╝╚══════╝╚═╝  ╚═══╝╚═════╝    ╚═╝   
    `);
    console.log("\x1b[35m============================================================================\x1b[0m");
    console.log(`\x1b[1m\x1b[33m🚀 TỔNG ĐÀI HENDY 5.2 ĐÃ SẴN SÀNG TẠI CỔNG: ${PORT} \x1b[0m`);
    console.log(`\x1b[90m(Hệ thống tự động ghi HTML/JSON mỗi khi có thay đổi trạng thái)\x1b[0m`);
});
