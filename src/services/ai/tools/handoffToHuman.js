// Tool: chuyển cho người thật — đánh dấu thread cần người hỗ trợ, AI tạm dừng cho tới khi nhân viên bật lại
module.exports = {
    name: 'handoff_to_human',
    label: 'Chuyển cho nhân viên',
    description: 'AI gọi khi khách muốn gặp người thật hoặc câu hỏi ngoài phạm vi. Hội thoại được gắn cờ "cần người hỗ trợ", AI ngừng trả lời cho tới khi nhân viên bật lại.',
    settingKey: 'handoff_to_human',
    definition: {
        description: 'Hand the conversation over to a human staff member. Call this when the customer explicitly asks for a human, is upset, or asks something outside your instructions that you cannot answer. After calling, tell the customer briefly that a staff member will follow up soon. You will stop replying in this conversation afterwards.',
        parameters: {
            type: 'object',
            properties: { reason: { type: 'string', description: 'Short reason for the handoff (for staff).' } },
            required: ['reason'],
            additionalProperties: false,
        },
    },
    async run(args, ctx) {
        const reason = String(args.reason || '').slice(0, 300);
        if (ctx.engine?.markNeedsHuman) ctx.engine.markNeedsHuman(ctx.threadId, reason);
        return { ok: true, note: 'Đã báo nhân viên. Hãy nói ngắn gọn với khách rằng sẽ có người hỗ trợ sớm, không hứa thời gian cụ thể.' };
    },
};
