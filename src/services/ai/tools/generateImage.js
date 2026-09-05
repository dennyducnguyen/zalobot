// Tool: tạo ảnh bằng provider ảnh (Gemini image model hoặc ChatGPT image_generation). Ảnh được gửi SAU câu trả lời text.
module.exports = {
    name: 'generate_image',
    label: 'Tạo ảnh',
    description: 'Cho AI tạo ảnh theo mô tả và gửi cho khách (tối đa 1 ảnh mỗi lượt). Cần chọn "Provider tạo ảnh" ở tab Provider.',
    settingKey: 'generate_image',
    definition: {
        description: 'Generate an image from a text prompt and send it to the customer in this chat. Use only when the customer asks for an image/picture/illustration. Write the prompt in English, detailed. At most one image per reply. Optionally use the most recent image the customer sent as a reference.',
        parameters: {
            type: 'object',
            properties: {
                prompt: { type: 'string', description: 'Detailed English description of the image to generate.' },
                size: { type: 'string', enum: ['1024x1024', '1024x1536', '1536x1024'], description: 'Image size. Default 1024x1024.' },
                use_last_customer_image_as_reference: { type: 'boolean', description: 'true to use the customer\'s most recent image as a reference (edit/variation).' },
            },
            required: ['prompt'],
            additionalProperties: false,
        },
    },
    available({ settings, providers }) {
        if (!settings.image_provider_id) return { ok: false, reason: 'Chưa chọn provider tạo ảnh' };
        const p = providers.getImage();
        if (!p) return { ok: false, reason: 'Provider tạo ảnh không tồn tại hoặc đang tắt' };
        if (!p.supports.image) return { ok: false, reason: `Provider "${p.name}" chưa có model tạo ảnh` };
        return { ok: true };
    },
    async run(args, ctx) {
        if ((ctx.attachments || []).some(a => a.kind === 'generated_image')) {
            return { ok: false, error: 'Đã tạo 1 ảnh trong lượt này — không tạo thêm.' };
        }
        const prompt = String(args.prompt || '').trim();
        if (!prompt) return { ok: false, error: 'Thiếu prompt' };
        const provider = ctx.providers.getImage();
        const refImages = args.use_last_customer_image_as_reference && ctx.recentImages?.length ? [ctx.recentImages[ctx.recentImages.length - 1]] : [];
        const img = await provider.generateImage({ prompt, size: args.size, refImages, timeoutMs: ctx.settings?.image_timeout_ms, signal: ctx.signal });
        ctx.attachments.push({ kind: 'generated_image', data: img.data, mime: img.mime, prompt });
        return { ok: true, note: 'Ảnh đã tạo xong và sẽ được gửi kèm ngay sau câu trả lời của bạn. Chỉ cần viết 1 câu ngắn giới thiệu ảnh.' };
    },
};
