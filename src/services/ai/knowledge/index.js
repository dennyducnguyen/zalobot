// =============================================
// Knowledge / RAG — điểm cắm cho tương lai. Hiện là NoopRetriever (trả rỗng).
// Khi làm RAG: thêm retriever dùng providers.getEmbedding().embed() + bảng knowledge_docs/knowledge_chunks
// (xem docs/AI-PLAN.md mục 2.3 và 9), rồi đổi createKnowledge() trả retriever thật.
// =============================================

/**
 * @typedef {{ text:string, title?:string, score?:number }} KnowledgeSnippet
 * @typedef {{ retrieve(params:{ query:string, threadType:string, limit?:number }): Promise<KnowledgeSnippet[]>, describe(): object }} KnowledgeRetriever
 */

class NoopRetriever {
    async retrieve() { return []; }
    describe() { return { kind: 'none', enabled: false }; }
}

function createKnowledge(/* { aiStore, providers, settings } */) {
    return new NoopRetriever();
}

/** Ghép snippet vào system prompt — dùng chung cho mọi retriever */
function formatSnippets(snippets) {
    if (!snippets?.length) return '';
    return '\n\n## Tài liệu tham khảo (ưu tiên dùng khi trả lời)\n' + snippets
        .map((s, i) => `[${i + 1}]${s.title ? ` ${s.title}:` : ''} ${s.text}`)
        .join('\n');
}

module.exports = { createKnowledge, NoopRetriever, formatSnippets };
