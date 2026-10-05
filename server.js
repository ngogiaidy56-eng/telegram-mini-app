const express = require('express');
const crypto = require('crypto');
const app = express();
app.use(express.json());

// Token của con Bot bạn nhận được từ @BotFather
const BOT_TOKEN = '8517026315:AAGSFv23fTHx2WFBSP25VJ5_-cBmU197BF8'; 

// Hàm kiểm tra xem dữ liệu gửi lên có phải xuất phát từ Telegram thật hay không
function verifyTelegramData(initData) {
    const urlParams = new URLSearchParams(initData);
    const hash = urlParams.get('hash');
    urlParams.delete('hash');

    // Sắp xếp các tham số theo thứ tự bảng chữ cái
    const dataCheckString = Array.from(urlParams.entries())
        .map(([key, value]) => `${key}=${value}`)
        .sort()
        .join('\n');

    // Tạo khóa bí mật từ Bot Token
    const secretKey = crypto.createHmac('sha256', 'WebAppData').update(BOT_TOKEN).digest();
    // Tạo mã băm để đối chiếu
    const calculatedHash = crypto.createHmac('sha256', secretKey).update(dataCheckString).digest('hex');

    // Nếu trùng khớp tức là dữ liệu chuẩn xác, không bị chỉnh sửa
    return calculatedHash === hash;
}

// API nhận dữ liệu từ Frontend gửi lên để xử lý thông tin ví/tài khoản
app.post('/api/auth', (req, res) => {
    const { initData } = req.body;

    if (!initData || !verifyTelegramData(initData)) {
        return res.status(403).json({ success: false, message: 'Dữ liệu không hợp lệ hoặc không đến từ Telegram!' });
    }

    // Dữ liệu hợp lệ, bạn có thể truy vấn Database để lấy số dư ví thực tế của User tại đây
    res.json({ success: true, message: 'Xác thực thành công!' });
});

app.listen(3000, () => console.log('Server đang chạy tại cổng 3000'));
