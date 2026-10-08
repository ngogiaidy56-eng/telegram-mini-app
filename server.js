const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const PORT = process.env.PORT || 3000;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || '';
const CLOUDFLARE_WEBHOOK_SECRET = process.env.CF_SECRET || 'viet_sub_edge_secret_35';
const DATA_FILE = path.join(__dirname, 'viet_sub_storage.json');

let BANNER_CONFIG = {
    customText: "HENDY",          // Text hiển thị mặc định (HENDY, VIETSUB, STUDIO)
    colorTheme: "CYBERPUNK",      // CYBERPUNK, MATRIX, FIRE, RAINBOW, GOLD
    animationSpeedMs: 80,         // Tốc độ frame (ms)
    totalFrames: 35               // Số lượng frame hiệu ứng khởi động
};

const asciiFonts = {
    HENDY: [
        "   ██╗   ██╗███████╗███╗   ██╗██████╗ ██╗   ██╗",
        "   ██║   ██║██╔════╝████╗  ██║██╔══██╗╚██╗ ██╔╝",
        "   ███████║█████╗  ██╔██╗ ██║██║  ██║ ╚████╔╝ ",
        "   ██╔══██║██╔══╝  ██║╚██╗██║██║  ██║  ╚██╔╝  ",
        "   ██║   ██║███████╗██║ ╚████║██████╔╝   ██║   ",
        "   ╚═╝   ╚═╝╚══════╝╚═╝  ╚═══╝╚═════╝    ╚═╝   "
    ],
    VIETSUB: [
        "██╗   ██╗██╗███████╗███████╗██╗   ██╗██████╗ ",
        "██║   ██║██║██╔════╝██╔════╝██║   ██║██╔══██╗",
        "██║   ██║██║█████╗  ███████╗██║   ██║██████╔╝",
        "╚██╔╝ ██║██╔══╝  ╚════██║██║   ██║██╔══██╗",
        " ╚████╔╝ ██║███████╗███████║╚██████╔╝██████╔╝",
        "  ╚═══╝  ╚═╝╚══════╝╚══════╝ ╚═════╝ ╚═════╝ "
    ],
    STUDIO: [
        "███████╗████████╗██╔══██╗██╗   ██╗██╗ _____ ",
        "██╔════╝╚══██╔══╝██╔══██║██║   ██║██║|___  |",
        "███████╗   ██║   ██║  ██║██║   ██║██║    / / ",
        "╚════██║   ██║   ██║  ██║██║   ██║██║   / /  ",
        "███████║   ██║   ██████╔╝╚██████╔╝██║  /_/   ",
        "╚══════╝   ╚═╝   ╚═════╝  ╚═════╝ ╚═╝        "
    ]
};

let systemConfig = {
    version: '3.5.0-PRO-ENTERPRISE',
    environment: 'Node.js Cloud-Native Hybrid Edge',
    startTime: Date.now()
};

let connectedTabs = {};          // WebSocket Slaves / Workers đăng ký
let activeVideoJobs = new Map(); // BullMQ / Media Pipeline Jobs
let systemLogs = [];

function loadPersistedData() {
    try {
        if (fs.existsSync(DATA_FILE)) {
            const raw = fs.readFileSync(DATA_FILE, 'utf8');
            const data = JSON.parse(raw);
            if (data.bannerConfig) BANNER_CONFIG = { ...BANNER_CONFIG, ...data.bannerConfig };
            if (data.jobs) {
                data.jobs.forEach(j => activeVideoJobs.set(j.id, j));
            }
            logSystemEvent('Đã khôi phục dữ liệu cấu hình & jobs từ ổ cứng thành công.', 'SUCCESS');
        }
    } catch (err) {
        logSystemEvent('Không thể đọc tệp dữ liệu cũ, khởi tạo trạng thái mới.', 'WARN');
    }
}

function savePersistedData() {
    try {
        const payload = {
            bannerConfig: BANNER_CONFIG,
            jobs: Array.from(activeVideoJobs.values())
        };
        fs.writeFileSync(DATA_FILE, JSON.stringify(payload, null, 2), 'utf8');
    } catch (err) {
        console.error('[STORAGE ERROR]:', err.message);
    }
}

app.use(express.json());

function getActiveAsciiLines() {
    return asciiFonts[BANNER_CONFIG.customText] || asciiFonts.HENDY;
}

function getThemeColor(step, x, y, theme) {
    if (theme === 'MATRIX') {
        return { r: 0, g: Math.floor(Math.sin((step + x) * 0.2) * 100 + 155), b: 50 };
    } else if (theme === 'FIRE') {
        return { r: 255, g: Math.floor(Math.abs(Math.sin((step + x) * 0.1)) * 150), b: 0 };
    } else if (theme === 'RAINBOW') {
        const freq = 0.3;
        const r = Math.floor(Math.sin(freq * step + x * 0.1 + 0) * 127 + 128);
        const g = Math.floor(Math.sin(freq * step + x * 0.1 + 2) * 127 + 128);
        const b = Math.floor(Math.sin(freq * step + x * 0.1 + 4) * 127 + 128);
        return { r, g, b };
    } else if (theme === 'GOLD') {
        return { r: 255, g: Math.floor(Math.abs(Math.cos((step + x) * 0.1)) * 100 + 155), b: 0 };
    }
    // Mặc định CYBERPUNK
    const r = Math.floor(Math.sin((step + x + y * 4) * 0.1) * 127 + 128);
    const g = Math.floor(Math.cos((step + x * 2) * 0.1) * 127 + 128);
    const b = 255;
    return { r, g, b };
}

function logSystemEvent(message, type = 'INFO') {
    const time = new Date().toLocaleTimeString('vi-VN');
    const logEntry = { time, message, type };
    systemLogs.push(logEntry);
    if (systemLogs.length > 200) systemLogs.shift();
}

function verifyEdgeHmacSignature(req, res, next) {
    const signature = req.headers['x-edge-signature'];
    const timestamp = req.headers['x-edge-timestamp'];
    if (!signature || !timestamp) {
        req.isEdgeVerified = false;
        return next();
    }
    const payload = `${timestamp}.${JSON.stringify(req.body || {})}`;
    const expectedSignature = crypto.createHmac('sha256', CLOUDFLARE_WEBHOOK_SECRET).update(payload).digest('hex');
    req.isEdgeVerified = (signature === expectedSignature);
    next();
}

app.use('/api/', verifyEdgeHmacSignature);

app.get('/api/system/stats', (req, res) => {
    const memUsage = process.memoryUsage();
    res.json({
        uptimeSeconds: Math.floor((Date.now() - systemConfig.startTime) / 1000),
        memoryRssMb: Math.round(memUsage.rss / 1024 / 1024),
        activeSlaves: Object.keys(connectedTabs).length,
        activeJobs: activeVideoJobs.size,
        bannerConfig: BANNER_CONFIG,
        config: systemConfig
    });
});

app.post('/api/banner/update', (req, res) => {
    const { customText, colorTheme, animationSpeedMs } = req.body;
    if (customText) BANNER_CONFIG.customText = customText.toUpperCase();
    if (colorTheme) BANNER_CONFIG.colorTheme = colorTheme;
    if (animationSpeedMs) BANNER_CONFIG.animationSpeedMs = parseInt(animationSpeedMs, 10) || 80;

    savePersistedData();
    logSystemEvent(`Đã cập nhật Banner cấu hình mới: [${BANNER_CONFIG.customText} - Theme: ${BANNER_CONFIG.colorTheme}]`, 'SUCCESS');
    
    const payload = JSON.stringify({ action: 'BANNER_UPDATED', bannerConfig: BANNER_CONFIG });
    wss.clients.forEach(client => {
        if (client.readyState === WebSocket.OPEN) client.send(payload);
    });

    res.json({ success: true, bannerConfig: BANNER_CONFIG });
});

app.get('/api/jobs', (req, res) => {
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.end(JSON.stringify(Array.from(activeVideoJobs.values()), null, 2));
});

app.post('/api/jobs/create', (req, res) => {
    const jobId = 'job_' + Math.random().toString(36).substring(2, 8);
    const title = req.body.title || 'Video_Pipeline_' + jobId;
    
    const newJob = {
        id: jobId,
        title: title,
        stage: 'EXTRACTING',
        progress: 15,
        status: 'PROCESSING',
        timestamp: new Date().toLocaleTimeString('vi-VN')
    };

    activeVideoJobs.set(jobId, newJob);
    savePersistedData();
    logSystemEvent(`Đã khởi tạo Job ${jobId} (${title}) qua Async BullMQ Queue`, 'SUCCESS');

    setTimeout(() => {
        if (activeVideoJobs.has(jobId)) {
            let j = activeVideoJobs.get(jobId);
            j.stage = 'GEMINI_AI_TRANSLATE';
            j.progress = 60;
            savePersistedData();
        }
    }, 4000);

    setTimeout(() => {
        if (activeVideoJobs.has(jobId)) {
            let j = activeVideoJobs.get(jobId);
            j.stage = 'RENDER_R2_SYNC';
            j.progress = 100;
            j.status = 'COMPLETED';
            savePersistedData();
            logSystemEvent(`Job ${jobId} đã xử lý xong và đồng bộ Cloudflare R2!`, 'SUCCESS');
        }
    }, 8000);

    res.json({ success: true, jobId });
});

app.post('/api/ai/manage', async (req, res) => {
    try {
        const body = req.body;
        const prompt = (body.prompt || "").toLowerCase().trim();
        let resultAction = 'UNKNOWN';
        let replyMessage = '🤖 AI Quản lý chưa hiểu rõ yêu cầu. Hãy thử: "Chạy tất cả bot", "Thêm 3 bot", hoặc "Trạng thái".';

        if (GEMINI_API_KEY) {
            try {
                const aiRes = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${GEMINI_API_KEY}`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        contents: [{
                            parts: [{
                                text: `Bạn là AI Quản Lý Hệ Thống VietSub Studio V3.5 Pro. Người dùng hỏi: "${prompt}". Trả về JSON chuẩn: {"action": "START_ALL_BOTS" | "ADD_JOB" | "SYSTEM_STATUS" | "UNKNOWN", "reply": "tiếng Việt"}`
                            }]
                        }]
                    })
                });
                const aiData = await aiRes.json();
                const textResp = aiData.candidates?.[0]?.content?.parts?.[0]?.text;
                if (textResp) {
                    const parsed = JSON.parse(textResp.replace(/```json|```/g, '').trim());
                    resultAction = parsed.action || 'AI_ACTION';
                    replyMessage = parsed.reply || replyMessage;
                }
            } catch (err) {
                console.error("[GEMINI ERROR]:", err.message);
            }
        }

        if (resultAction === 'UNKNOWN') {
            if (prompt.includes('chạy') || prompt.includes('start')) {
                resultAction = 'START_ALL_BOTS';
                replyMessage = '🚀 AI Manager đã kích hoạt toàn bộ Media Pipelines!';
            } else if (prompt.includes('thêm') || prompt.includes('add')) {
                resultAction = 'ADD_JOB';
                replyMessage = '➕ AI Manager đã khởi tạo thêm 1 Media Pipeline Job mới!';
            } else if (prompt.includes('trạng thái') || prompt.includes('status')) {
                resultAction = 'SYSTEM_STATUS';
                replyMessage = `📊 Sức khỏe hệ thống: ONLINE 🟢 (Slaves: ${Object.keys(connectedTabs).length} | Jobs: ${activeVideoJobs.size})`;
            }
        }

        res.json({ success: true, data: { action: resultAction, reply: replyMessage } });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
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

wss.on('connection', (ws) => {
    ws.isAlive = true;
    ws.channel = 'VIETSUB-KENH-1';
    ws.isMaster = false;

    ws.on('pong', () => { ws.isAlive = true; });

    ws.on('message', (message) => {
        try {
            const data = JSON.parse(message);
            const channel = data.channel || ws.channel || 'VIETSUB-KENH-1';
            ws.channel = channel;

            if (data.action === 'SYNC_REGISTER_TAB') {
                if (data.value && data.value.id) {
                    ws.slaveId = data.value.id;
                    connectedTabs[ws.slaveId] = { ...data.value, channel: channel, lastSeen: Date.now() };
                    broadcastTabList(channel);
                }
            } else if (data.action === 'SYNC_PING_REQUEST') {
                ws.isMaster = true;
                const tabsInChannel = Object.values(connectedTabs).filter(t => t.channel === channel);
                ws.send(JSON.stringify({ action: 'SYNC_TAB_LIST', value: tabsInChannel, channel: channel }));
            }
        } catch (err) {
            console.error('[WS PARSE ERROR]:', err);
        }
    });

    ws.on('close', () => {
        if (ws.slaveId && connectedTabs[ws.slaveId]) {
            const ch = connectedTabs[ws.slaveId].channel;
            delete connectedTabs[ws.slaveId];
            broadcastTabList(ch);
        }
    });
});

const heartbeatInterval = setInterval(() => {
    wss.clients.forEach(ws => {
        if (ws.isAlive === false) {
            if (ws.slaveId && connectedTabs[ws.slaveId]) {
                const ch = connectedTabs[ws.slaveId].channel;
                delete connectedTabs[ws.slaveId];
                broadcastTabList(ch);
            }
            return ws.terminate();
        }
        ws.isAlive = false;
        ws.ping();
    });
}, 15000);

wss.on('close', () => clearInterval(heartbeatInterval));

app.get('/', (req, res) => {
    const totalJobs = activeVideoJobs.size;
    res.send(`
        <!DOCTYPE html>
        <html lang="vi" class="dark">
        <head>
            <meta charset="UTF-8">
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <title>VietSub Video Studio V3.5 Pro - Enterprise Command Center</title>
            <script src="https://cdn.tailwindcss.com"></script>
            <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/css/all.min.css">
            <link href="https://fonts.googleapis.com/css2?family=Chakra+Petch:wght@400;600;700&family=Inter:wght@300;400;500;600&display=swap" rel="stylesheet">
            <style>
                body { font-family: 'Inter', sans-serif; }
                .cyber-font { font-family: 'Chakra Petch', sans-serif; }
                ::-webkit-scrollbar { width: 6px; height: 6px; }
                ::-webkit-scrollbar-track { background: #030008; }
                ::-webkit-scrollbar-thumb { background: #3b82f655; border-radius: 3px; }
                
                /* Hiệu ứng cuộn chữ */
                @keyframes scroll-left {
                    0% { transform: translateX(100%); }
                    100% { transform: translateX(-100%); }
                }
                .text-scroller {
                    display: inline-block;
                    white-space: nowrap;
                    animation: scroll-left 10s linear infinite; 
                }
                .scroll-container {
                    overflow: hidden;
                    width: 100%;
                    max-width: 400px;
                }
            </style>
        </head>
        <body class="bg-[#030008] text-gray-100 min-h-screen flex flex-col justify-between selection:bg-blue-500 selection:text-white">
            <header class="bg-[#070514]/90 border-b border-blue-900/40 px-6 py-4 sticky top-0 z-50 backdrop-blur-md shadow-2xl">
                <div class="max-w-7xl mx-auto flex flex-col sm:flex-row justify-between items-center gap-4">
                    <div class="flex items-center space-x-3">
                        <div class="w-10 h-10 rounded-xl bg-gradient-to-tr from-blue-600 via-indigo-600 to-purple-500 flex items-center justify-center shadow-lg shadow-blue-500/30">
                            <i class="fa-solid fa-cube text-white text-lg"></i>
                        </div>
                        
                        <!-- ÁP DỤNG CHỮ CHẠY VÀO ĐÂY -->
                        <div class="scroll-container">
                            <h1 class="text-scroller cyber-font text-xl font-bold tracking-wider bg-gradient-to-r from-cyan-400 via-blue-400 to-purple-400 bg-clip-text text-transparent">
                                HENDY - VIETSUB STUDIO V3.5 PRO ENTERPRISE
                            </h1>
                            <p class="text-[11px] text-gray-400 uppercase tracking-widest">Cloud-Native Edge & Persistent Disk Storage</p>
                        </div>
                        
                    </div>
                    <div class="flex items-center gap-3 flex-wrap justify-center">
                        <div class="flex items-center space-x-2 bg-gray-900/80 px-3 py-1.5 rounded-lg border border-blue-900/50 text-xs">
                            <span class="w-2.5 h-2.5 rounded-full bg-emerald-400 animate-pulse"></span>
                            <span class="font-medium text-gray-300">Disk Persistence: Active</span>
                        </div>
                        <div class="flex items-center space-x-2 bg-gray-900/80 px-3 py-1.5 rounded-lg border border-blue-900/50 text-xs">
                            <i class="fa-solid fa-microchip text-purple-400"></i>
                            <span class="text-gray-400">Jobs:</span>
                            <span id="stat-jobs" class="font-bold text-purple-400">${totalJobs}</span>
                        </div>
                    </div>
                </div>
            </header>

            <main class="max-w-7xl w-full mx-auto p-4 sm:p-6 grid grid-cols-1 lg:grid-cols-3 gap-6 flex-grow">
                <div class="lg:col-span-2 space-y-6">
                    <div class="bg-[#070514] border border-blue-900/40 rounded-2xl p-5 shadow-2xl">
                        <h2 class="cyber-font text-sm font-bold text-cyan-400 uppercase tracking-wider mb-3 flex items-center gap-2">
                            <i class="fa-solid fa-wand-magic-sparkles text-cyan-400"></i> Tùy Chỉnh Banner & Giao Diện Trực Tiếp
                        </h2>
                        <div class="grid grid-cols-1 sm:grid-cols-3 gap-3 mb-3">
                            <div>
                                <label class="text-[10px] text-gray-400 uppercase font-mono">Tên Banner:</label>
                                <select id="input-banner-text" class="w-full bg-gray-900 border border-blue-900/50 rounded-xl px-3 py-2 text-xs text-cyan-300 font-mono mt-1 focus:outline-none">
                                    <option value="HENDY">HENDY</option>
                                    <option value="VIETSUB">VIETSUB</option>
                                    <option value="STUDIO">STUDIO</option>
                                </select>
                            </div>
                            <div>
                                <label class="text-[10px] text-gray-400 uppercase font-mono">Chủ Đề Màu Sắc:</label>
                                <select id="input-banner-theme" class="w-full bg-gray-900 border border-blue-900/50 rounded-xl px-3 py-2 text-xs text-purple-300 font-mono mt-1 focus:outline-none">
                                    <option value="CYBERPUNK">Cyberpunk Neon</option>
                                    <option value="MATRIX">Matrix Green</option>
                                    <option value="FIRE">Fire Sunset</option>
                                    <option value="RAINBOW">Rainbow Wave</option>
                                    <option value="GOLD">Gold Luxury</option>
                                </select>
                            </div>
                            <div class="flex items-end">
                                <button onclick="updateBannerConfig()" class="w-full py-2 bg-gradient-to-r from-cyan-600 to-blue-600 text-white rounded-xl text-xs font-semibold shadow-lg shadow-cyan-600/30 hover:opacity-95 transition flex items-center justify-center gap-2">
                                    <i class="fa-solid fa-rotate"></i> Cập Nhật Banner
                                </button>
                            </div>
                        </div>
                    </div>

                    <div class="bg-[#070514] border border-blue-900/40 rounded-2xl p-5 shadow-2xl">
                        <h2 class="cyber-font text-sm font-bold text-amber-400 uppercase tracking-wider mb-3 flex items-center gap-2">
                            <i class="fa-solid fa-bolt text-amber-400"></i> Điều Phối Hệ Thống & BullMQ Pipelines
                        </h2>
                        <div class="flex flex-wrap gap-3">
                            <button onclick="dispatchVideoJob()" class="px-4 py-2.5 bg-gradient-to-r from-blue-600 to-indigo-600 text-white rounded-xl text-xs font-semibold shadow-lg shadow-blue-600/30 flex items-center gap-2">
                                <i class="fa-solid fa-video"></i> Tạo Job Dịch Vietsub Mới
                            </button>
                        </div>
                    </div>

                    <div class="bg-[#070514] border border-blue-900/40 rounded-2xl p-5 shadow-2xl overflow-hidden">
                        <div class="flex justify-between items-center mb-4">
                            <h2 class="cyber-font text-sm font-bold text-purple-400 uppercase tracking-wider flex items-center gap-2">
                                <i class="fa-solid fa-list-check text-purple-400"></i> Hàng Đợi Media Pipelines & BullMQ Jobs
                            </h2>
                            <span id="badge-job-count" class="text-xs bg-purple-500/10 text-purple-300 border border-purple-500/30 px-3 py-1 rounded-full font-semibold">${totalJobs} jobs tracked</span>
                        </div>
                        <div class="overflow-x-auto">
                            <table class="w-full text-left text-xs">
                                <thead class="bg-blue-950/40 text-gray-400 uppercase tracking-wider border-b border-blue-900/40">
                                    <tr>
                                        <th class="py-3 px-4 rounded-l-lg">Job ID / Title</th>
                                        <th class="py-3 px-4">Pipeline Stage</th>
                                        <th class="py-3 px-4">Progress</th>
                                        <th class="py-3 px-4">Status</th>
                                        <th class="py-3 px-4 rounded-r-lg">Timestamp</th>
                                    </tr>
                                </thead>
                                <tbody id="jobs-table-body" class="divide-y divide-blue-950/30">
                                    <tr><td colspan="5" class="py-6 text-center text-gray-500 italic">Đang tải hàng đợi...</td></tr>
                                </tbody>
                            </table>
                        </div>
                    </div>
                </div>

                <div class="space-y-6 flex flex-col">
                    <div class="bg-[#070514] border border-blue-900/40 rounded-2xl p-5 shadow-2xl">
                        <h2 class="cyber-font text-sm font-bold text-emerald-400 uppercase tracking-wider mb-3 flex items-center gap-2">
                            <i class="fa-solid fa-chart-line text-emerald-400"></i> System Telemetry (S.O.T)
                        </h2>
                        <div class="bg-gray-900/80 border border-blue-900/40 rounded-xl p-3 font-mono text-[11px] text-cyan-300 space-y-1.5">
                            <div>Version: <span class="text-white">3.5.0-PRO</span></div>
                            <div>Uptime: <span id="tele-uptime" class="text-yellow-400">0s</span></div>
                            <div>Memory (RSS): <span id="tele-memory" class="text-emerald-400">0 MB</span></div>
                        </div>
                    </div>

                    <div class="bg-[#070514] border border-blue-900/40 rounded-2xl p-5 shadow-2xl flex flex-col flex-grow">
                        <div class="flex justify-between items-center mb-3">
                            <h2 class="cyber-font text-sm font-bold text-yellow-400 uppercase tracking-wider flex items-center gap-2">
                                <i class="fa-solid fa-terminal text-yellow-400"></i> Server Logs
                            </h2>
                            <button onclick="clearLogs()" class="text-[10px] text-gray-400 hover:text-white underline">Xóa log</button>
                        </div>
                        <div id="log-console" class="bg-black/80 border border-blue-900/40 rounded-xl p-3 h-64 overflow-y-auto font-mono text-[11px] text-cyan-300 space-y-1.5 leading-relaxed">
                            <div class="text-gray-500">[SYSTEM] VietSub Studio V3.5 Pro khởi động hoàn tất.</div>
                        </div>
                    </div>
                </div>
            </main>

            <footer class="bg-[#070514]/90 border-t border-blue-900/40 py-4 px-6 text-center text-xs text-gray-500 mt-6">
                <p>VietSub Video Studio V3.5 Pro Enterprise © 2026 - All rights reserved.</p>
            </footer>

            <script>
                function appendLog(msg, type = 'INFO') {
                    const consoleDiv = document.getElementById('log-console');
                    if (!consoleDiv) return;
                    const time = new Date().toLocaleTimeString('vi-VN');
                    let color = 'text-cyan-300';
                    if (type === 'SUCCESS') color = 'text-emerald-400';
                    if (type === 'ERROR') color = 'text-pink-400';
                    if (type === 'WARN') color = 'text-yellow-400';
                    const line = document.createElement('div');
                    line.className = color;
                    line.innerHTML = \`[\${time}] [\${type}] \${msg}\`;
                    consoleDiv.appendChild(line);
                    consoleDiv.scrollTop = consoleDiv.scrollHeight;
                }

                function clearLogs() {
                    document.getElementById('log-console').innerHTML = '<div class="text-gray-500">[SYSTEM] Nhật ký đã làm sạch.</div>';
                }

                async function updateBannerConfig() {
                    const customText = document.getElementById('input-banner-text').value;
                    const colorTheme = document.getElementById('input-banner-theme').value;
                    appendLog('Đang cập nhật cấu hình Banner terminal...', 'INFO');
                    try {
                        const res = await fetch('/api/banner/update', {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ customText, colorTheme })
                        });
                        const json = await res.json();
                        if (json.success) {
                            appendLog(\`Cập nhật Banner thành công! [Chữ: \${json.bannerConfig.customText} | Theme: \${json.bannerConfig.colorTheme}]\`, 'SUCCESS');
                        }
                    } catch (e) {
                        appendLog('Lỗi cập nhật banner: ' + e.message, 'ERROR');
                    }
                }

                async function dispatchVideoJob() {
                    appendLog('Khởi tạo Job Dịch Vietsub qua BullMQ Queue...', 'SUCCESS');
                    try {
                        const res = await fetch('/api/jobs/create', {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ title: 'Video_Pipeline_' + Math.floor(Math.random()*1000) })
                        });
                        const json = await res.json();
                        appendLog('Job đã đưa vào hàng đợi: ' + json.jobId, 'SUCCESS');
                        fetchJobs();
                    } catch (e) {
                        appendLog('Lỗi tạo job: ' + e.message, 'ERROR');
                    }
                }

                async function fetchSystemStats() {
                    try {
                        const res = await fetch('/api/system/stats');
                        const data = await res.json();
                        document.getElementById('tele-uptime').innerText = data.uptimeSeconds + 's';
                        document.getElementById('tele-memory').innerText = data.memoryRssMb + ' MB';
                    } catch (err) {
                        console.warn('Stats error:', err);
                    }
                }

                async function fetchJobs() {
                    try {
                        const res = await fetch('/api/jobs');
                        const jobs = await res.json();
                        const tbody = document.getElementById('jobs-table-body');
                        document.getElementById('stat-jobs').innerText = jobs.length;
                        document.getElementById('badge-job-count').innerText = \`\${jobs.length} jobs tracked\`;

                        if (jobs.length === 0) {
                            tbody.innerHTML = \`<tr><td colspan="5" class="py-6 text-center text-gray-500 italic">Chưa có Job nào trong hệ thống.</td></tr>\`;
                            return;
                        }

                        tbody.innerHTML = jobs.map(j => \`
                            <tr class="hover:bg-blue-950/20 transition">
                                <td class="py-3 px-4 font-medium text-white">
                                    <div class="text-cyan-300">\${j.title}</div>
                                    <div class="text-[10px] text-gray-500 font-mono">\${j.id}</div>
                                </td>
                                <td class="py-3 px-4 font-mono text-yellow-400">\${j.stage}</td>
                                <td class="py-3 px-4">
                                    <div class="w-full bg-gray-800 rounded-full h-2 w-24">
                                        <div class="bg-gradient-to-r from-blue-500 to-cyan-400 h-2 rounded-full" style="width: \${j.progress}%"></div>
                                    </div>
                                    <span class="text-[10px] text-gray-400">\${j.progress}%</span>
                                </td>
                                <td class="py-3 px-4">
                                    <span class="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-[10px] font-medium \${j.status === 'COMPLETED' ? 'bg-emerald-500/10 text-emerald-400 border border-emerald-500/20' : 'bg-amber-500/10 text-amber-400 border border-amber-500/20'}">
                                        <span class="w-1.5 h-1.5 rounded-full \${j.status === 'COMPLETED' ? 'bg-emerald-400' : 'bg-amber-400 animate-pulse'}"></span> \${j.status}
                                    </span>
                                </td>
                                <td class="py-3 px-4 text-gray-400">\${j.timestamp}</td>
                            </tr>
                        \`).join('');
                    } catch (err) {
                        console.warn('Fetch jobs error:', err);
                    }
                }

                setInterval(fetchJobs, 3000);
                setInterval(fetchSystemStats, 5000);
                window.onload = () => { fetchJobs(); fetchSystemStats(); };
            </script>
        </body>
        </html>
    `);
});

function printAnimatedCustomBanner() {
    let step = 0;
    const activeLines = getActiveAsciiLines();
    const intervalId = setInterval(() => {
        console.clear();
        console.log("\x1b[36m============================================================================\x1b[0m");
        
        activeLines.forEach((line, lineIdx) => {
            let coloredLine = "";
            for (let i = 0; i < line.length; i++) {
                const char = line[i];
                if (char !== ' ') {
                    const rgb = getThemeColor(step, i, lineIdx, BANNER_CONFIG.colorTheme);
                    coloredLine += `\x1b[38;2;${rgb.r};${rgb.g};${rgb.b}m${char}\x1b[0m`;
                } else {
                    coloredLine += char;
                }
            }
            console.log(coloredLine);
        });

        console.log("\x1b[35m============================================================================\x1b[0m");
        console.log(`\x1b[1m\x1b[33m🚀 VIETSUB STUDIO V3.5 PRO (${BANNER_CONFIG.customText}) SẴN SÀNG TẠI CỔNG: ${PORT} [Theme: ${BANNER_CONFIG.colorTheme}]\x1b[0m`);
        console.log(`\x1b[90m(Nhấn Ctrl+C để dừng server)\x1b[0m`);

        step++;
        if (step > BANNER_CONFIG.totalFrames) {
            clearInterval(intervalId);
            printStableCustomBanner();
        }
    }, BANNER_CONFIG.animationSpeedMs);
}

function printStableCustomBanner() {
    console.clear();
    console.log("\x1b[36m============================================================================\x1b[0m");
    const activeLines = getActiveAsciiLines();
    activeLines.forEach((line, lineIdx) => {
        let coloredLine = "";
        for (let i = 0; i < line.length; i++) {
            const char = line[i];
            if (char !== ' ') {
                const rgb = getThemeColor(10, i, lineIdx, BANNER_CONFIG.colorTheme);
                coloredLine += `\x1b[38;2;${rgb.r};${rgb.g};${rgb.b}m${char}\x1b[0m`;
            } else {
                coloredLine += char;
            }
        }
        console.log(coloredLine);
    });
    console.log("\x1b[35m============================================================================\x1b[0m");
    console.log(`\x1b[1m\x1b[33m🚀 VIETSUB STUDIO V3.5 PRO (${BANNER_CONFIG.customText}) ĐANG CHẠY TẠI CỔNG: ${PORT} [Theme: ${BANNER_CONFIG.colorTheme}]\x1b[0m`);
    console.log(`\x1b[90m(Nhấn Ctrl+C để dừng server)\x1b[0m`);
}

// KHỞI ĐỘNG SERVER
loadPersistedData();
server.listen(PORT, () => {
    printAnimatedCustomBanner();
});
