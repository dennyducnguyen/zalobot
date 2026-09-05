// Tool: giờ hiện tại theo múi giờ Việt Nam — luôn bật (không có settingKey)
module.exports = {
    name: 'get_current_time',
    label: 'Xem giờ hiện tại',
    description: 'Cho AI biết ngày giờ hiện tại (múi giờ Việt Nam) khi cần hẹn lịch, tính hạn, chào theo buổi.',
    settingKey: null,
    definition: {
        description: 'Get the current date and time in Vietnam timezone (Asia/Ho_Chi_Minh). Use when the answer depends on the current time or date.',
        parameters: { type: 'object', properties: {}, additionalProperties: false },
    },
    async run() {
        const now = new Date();
        const tz = 'Asia/Ho_Chi_Minh';
        return {
            ok: true,
            iso: now.toISOString(),
            timezone: tz,
            human: now.toLocaleString('vi-VN', { timeZone: tz, weekday: 'long', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }),
        };
    },
};
