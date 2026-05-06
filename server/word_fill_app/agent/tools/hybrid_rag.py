"""
Tool: hybrid_rag — 混合检索（BM25 + Chroma 向量 + RRF 融合）

Phase 2 实现：
- 替换 Phase 1 的简化 BM25/HashEmbedding 为真正的混合检索
- BM25 基于 SQLite LIKE
- 向量检索基于 Chroma
- RRF（Reciprocal Rank Fusion）融合排序
- Chroma 不可用时自动降级为纯 BM25
"""

from langchain_core.tools import tool
import json
from typing import Dict, List, Any, Optional

from kb.vector_store import (
    hybrid_search,
    bm25_search,
    chroma_search,
    is_chroma_available,
)


@tool
def hybrid_rag_retrieve(
    query: str,
    doc_type: str = "",
    top_k: int = 5
) -> str:
    """混合检索知识库中的相关内容（BM25 + 向量语义 + RRF 融合）。

    从个人知识库和导入的文档中检索与查询最相关的片段。
    支持 CV、研究介绍、论文摘要等多种文档类型。

    Args:
        query: 查询文本，描述需要找什么信息。
            例如："该作者的代表性论文" 或 "已获批的科研项目"
        doc_type: 可选的文档类型过滤。
            - "cv": 个人简历/CV
            - "research": 研究成果/项目介绍
            - "general": 通用文档（默认）
            - "": 不过滤
        top_k: 返回结果数量（默认 5）

    Returns:
        JSON 字符串，包含检索结果列表。
        每个结果有 content、score、source、retriever 字段。
    """
    try:
        doc_type_filter = doc_type if doc_type else None

        # 执行混合检索
        results = hybrid_search(
            query=query,
            top_k=top_k,
            doc_type=doc_type_filter,
            alpha=0.5,  # BM25 和向量各占一半权重
        )
        top_sources = [r.get("source", "") for r in results[:3]]
        print(f"[hybrid_rag_retrieve] query='{query[:80]}', doc_type='{doc_type_filter or 'all'}', total={len(results)}, top_sources={top_sources}")

        if not results:
            return json.dumps({
                "success": True,
                "results": [],
                "total": 0,
                "message": "未找到相关内容",
                "chroma_available": is_chroma_available(),
            }, ensure_ascii=False)

        # 截断过长的内容
        for r in results:
            if len(r.get("content", "")) > 2000:
                r["content"] = r["content"][:2000] + "..."

        return json.dumps({
            "success": True,
            "results": results,
            "total": len(results),
            "query": query,
            "chroma_available": is_chroma_available(),
        }, ensure_ascii=False)

    except Exception as e:
        return json.dumps({
            "success": False,
            "error": str(e),
            "results": [],
            "total": 0,
        }, ensure_ascii=False)
