// =============================================
// Logger — tách kênh (app / login / error) theo ngày
// Tất cả vẫn ghi console (PM2 bắt được)
// ERROR từ mọi kênh tự copy sang logs/error/
// =============================================
const fs = require('fs');
const path = require('path');

const LOG_ROOT = path.join(__dirname, '../../logs');

function today() {
    return new Date().toISOString().slice(0, 10); // yyyy-mm-dd
}

function timestamp() {
    return new Date().toISOString().replace('T', ' ').slice(0, 19);
}

function writeFileLog(channel, level, text) {
    try {
        const dir = path.join(LOG_ROOT, channel);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        fs.appendFileSync(path.join(dir, `${today()}.log`), `[${timestamp()}] [${level}] ${text}\n`);
    } catch (e) { /* logging không được phép crash app */ }
}

function format(args) {
    return args
        .map(a => {
            if (a instanceof Error) return `${a.message}\n${a.stack}`;
            if (typeof a === 'object') { try { return JSON.stringify(a); } catch { return String(a); } }
            return String(a);
        })
        .join(' ');
}

function makeChannel(channel) {
    const log = (level, consoleFn, args) => {
        const text = format(args);
        consoleFn(`[${channel}] ${text}`);
        writeFileLog(channel, level, text);
        // Mọi ERROR đều copy sang kênh error tổng hợp
        if (level === 'ERROR' && channel !== 'error') {
            writeFileLog('error', 'ERROR', `[${channel}] ${text}`);
        }
    };
    return {
        info: (...args) => log('INFO', console.log, args),
        warn: (...args) => log('WARN', console.warn, args),
        error: (...args) => log('ERROR', console.error, args),
    };
}

const appChannel = makeChannel('app');

module.exports = {
    info: appChannel.info,
    warn: appChannel.warn,
    error: appChannel.error,
    login: makeChannel('login'),
};
