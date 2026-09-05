// =============================================
// SSE Hub — đẩy realtime cho web UI (tin nhắn mới, trạng thái kênh)
// Không cần socket.io — SSE qua nginx proxy chỉ cần header X-Accel-Buffering: no
// =============================================
const clients = new Set();

function addClient(res) {
    res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no', // nginx không buffer stream này
    });
    res.write(`event: connected\ndata: {}\n\n`);
    clients.add(res);
    res.on('close', () => clients.delete(res));
}

function broadcast(event, data) {
    const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const res of clients) {
        try { res.write(payload); } catch (e) { clients.delete(res); }
    }
}

// Heartbeat 25s giữ kết nối qua proxy
setInterval(() => {
    for (const res of clients) {
        try { res.write(`: ping\n\n`); } catch (e) { clients.delete(res); }
    }
}, 25000).unref();

module.exports = { addClient, broadcast };
