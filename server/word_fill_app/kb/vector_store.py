"""
Vector Store — Chroma 向量库 + BM25 + RRF 混合检索

与 kb_documents 表联动：
- 导入文档时，同时写入 SQLite 和 Chroma
- 检索时，BM25（SQL LIKE）+ Chroma 向量检索 + RRF 融合
- Chroma 不可用时自动降级为纯 BM25
"""

from __future__ import annotations

import json
import math
import re
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

from .database import get_kb, DATA_DIR

# ─── BM25 检索（基于 SQLite LIKE）─────────────────────────────

def bm25_search(
    query: str,
    top_k: int = 10,
    doc_type: Optional[str] = None,
) -> List[Dict[str, Any]]:
    """
    基于 SQLite LIKE 的 BM25 简化检索。

    将查询拆分为关键词，每个关键词用 LIKE 匹配，
    按匹配数量排序（简化 BM25，不考虑 IDF）。

    Args:
        query: 查询文本
        top_k: 返回结果数量
        doc_type: 可选的文档类型过滤

    Returns:
        [{"id": ..., "content": ..., "score": ..., "source": ...}]
    """
    kb = get_kb()

    # 分词（中文简单按字符，英文按空格）
    tokens = _tokenize(query)
    if not tokens:
        return []

    # 构建 LIKE 查询（匹配任意关键词即得分）
    conditions = []
    params = []
    for token in tokens:
        conditions.append("content LIKE ?")
        params.append(f"%{token}%")

    where_sql = " OR ".join(conditions)

    if doc_type:
        where_sql = f"({where_sql}) AND doc_type = ?"
        params.append(doc_type)

    sql = f"""
        SELECT id, source, doc_type, title, content, chunk_index, metadata
        FROM kb_documents
        WHERE {where_sql}
        ORDER BY updated_at DESC
    """

    try:
        rows = kb.personal.execute(sql, params).fetchall()
    except Exception:
        return []

    # 计算每个结果的关键词匹配数（简化 BM25 score）
    scored = []
    for row in rows:
        content_lower = row["content"].lower()
        match_count = sum(1 for token in tokens if token in content_lower)
        if match_count > 0:
            scored.append({
                "id": row["id"],
                "content": row["content"],
                "source": row["source"],
                "doc_type": row["doc_type"],
                "title": row["title"],
                "chunk_index": row["chunk_index"],
                "metadata": json.loads(row["metadata"]) if row["metadata"] else {},
                "score": match_count / len(tokens),  # 归一化分数
                "retriever": "bm25",
            })

    scored.sort(key=lambda x: x["score"], reverse=True)
    return scored[:top_k]


# ─── Chroma 向量检索 ─────────────────────────────────────────

_chroma_client = None
_chroma_collection = None
_chroma_available = None  # None=未检测, True/False


def _get_chroma():
    """懒加载 Chroma 客户端"""
    global _chroma_client, _chroma_available

    if _chroma_available is False:
        return None

    if _chroma_client is not None:
        return _chroma_client

    try:
        import chromadb
        persist_dir = str(DATA_DIR / "chroma_db")
        _chroma_client = chromadb.PersistentClient(path=persist_dir)
        _chroma_available = True
        print("[VectorStore] Chroma 就绪:", persist_dir)
        return _chroma_client
    except ImportError:
        _chroma_available = False
        print("[VectorStore] chromadb 未安装，降级为纯 BM25 检索")
        return None
    except Exception as e:
        _chroma_available = False
        print(f"[VectorStore] Chroma 初始化失败: {e}，降级为纯 BM25")
        return None


def _get_or_create_collection(name: str = "zafs_documents"):
    """获取或创建 Chroma collection"""
    client = _get_chroma()
    if client is None:
        return None

    try:
        return client.get_or_create_collection(
            name=name,
            metadata={"hnsw:space": "cosine"},
        )
    except Exception as e:
        print(f"[VectorStore] Collection 创建失败: {e}")
        return None


def _get_embedding_function():
    """获取 Embedding 函数"""
    client = _get_chroma()
    if client is None:
        return None

    try:
        # 优先使用 chromadb 内置的默认 embedding
        # 用户可通过环境变量配置自定义 embedding model
        import os
        model_name = os.environ.get("ZAFS_EMBEDDING_MODEL", "")

        if model_name:
            # 使用 sentence-transformers
            from chromadb.utils.embedding_functions import SentenceTransformerEmbeddingFunction
            return SentenceTransformerEmbeddingFunction(model_name=model_name)
        else:
            # 使用 chromadb 默认的 all-MiniLM-L6-v2
            return None  # 让 chromadb 使用默认
    except ImportError:
        return None


def chroma_search(
    query: str,
    top_k: int = 10,
    doc_type: Optional[str] = None,
) -> List[Dict[str, Any]]:
    """
    使用 Chroma 向量检索。

    Args:
        query: 查询文本
        top_k: 返回结果数量
        doc_type: 可选的文档类型过滤

    Returns:
        [{"content": ..., "score": ..., "source": ..., "retriever": "chroma"}]
    """
    collection = _get_or_create_collection()
    if collection is None:
        return []

    try:
        where_filter = None
        if doc_type:
            where_filter = {"doc_type": doc_type}

        # Chroma 要求 n_results >= 1，且不能超过 collection 中的文档数
        count = collection.count()
        if count == 0:
            return []
        n = max(1, min(top_k, count))
        results = collection.query(
            query_texts=[query],
            n_results=n,
            where=where_filter,
            include=["documents", "metadatas", "distances"],
        )

        if not results or not results["documents"] or not results["documents"][0]:
            return []

        items = []
        for i, doc in enumerate(results["documents"][0]):
            metadata = results["metadatas"][0][i] if results["metadatas"] else {}
            distance = results["distances"][0][i] if results["distances"] else 0

            # Chroma 返回的是距离（越小越好），转换为相似度分数（越大越好）
            score = max(0, 1 - distance)

            items.append({
                "content": doc,
                "source": metadata.get("source", ""),
                "doc_type": metadata.get("doc_type", ""),
                "title": metadata.get("title", ""),
                "chunk_index": metadata.get("chunk_index", 0),
                "metadata": metadata,
                "score": round(score, 4),
                "retriever": "chroma",
            })

        return items

    except Exception as e:
        print(f"[VectorStore] Chroma 查询失败: {e}")
        return []


def hybrid_search(
    query: str,
    top_k: int = 5,
    alpha: float = 0.5,
    doc_type: Optional[str] = None,
) -> List[Dict[str, Any]]:
    """
    混合检索：BM25 + Chroma 向量 + RRF 融合。

    Args:
        query: 查询文本
        top_k: 返回结果数量
        alpha: BM25 权重（0=纯向量，1=纯BM25）
        doc_type: 可选的文档类型过滤

    Returns:
        融合排序后的结果列表
    """
    k = 60  # RRF 常数

    # 1. BM25 检索
    bm25_results = bm25_search(query, top_k * 3, doc_type)
    rrf_scores: Dict[str, float] = {}

    for rank, item in enumerate(bm25_results):
        key = f"{item['source']}:{item.get('chunk_index', 0)}"
        rrf_scores[key] = rrf_scores.get(key, 0) + alpha / (k + rank + 1)

    # 2. Chroma 向量检索
    chroma_results = chroma_search(query, top_k * 3, doc_type)
    for rank, item in enumerate(chroma_results):
        key = f"{item['source']}:{item.get('chunk_index', 0)}"
        rrf_scores[key] = rrf_scores.get(key, 0) + (1 - alpha) / (k + rank + 1)

    # 3. 去重合并（BM25 结果优先，补充 Chroma 的 metadata）
    all_items = {}
    for item in bm25_results:
        key = f"{item['source']}:{item.get('chunk_index', 0)}"
        all_items[key] = item
    for item in chroma_results:
        key = f"{item['source']}:{item.get('chunk_index', 0)}"
        if key not in all_items:
            all_items[key] = item

    # 4. 按 RRF 分数排序
    results = []
    for key, score in sorted(rrf_scores.items(), key=lambda x: x[1], reverse=True)[:top_k]:
        item = all_items.get(key, {})
        item["score"] = round(score, 4)
        item["retriever"] = "hybrid_rrf"
        results.append(item)

    return results


# ─── 论文向量检索 Collection ────────────────────────────────

PAPER_COLLECTION_NAME = "zafs_papers"

# 论文结构化字段定义（按科研维度组织）
PAPER_FIELD_TYPES = {
    # 基础信息
    "title": "论文标题",
    "abstract": "摘要",
    "keywords": "关键词",
    # 科研维度
    "background": "研究背景",
    "theory": "理论框架",
    "method": "研究方法",
    "experiment": "实验结果",
    "conclusion": "研究结论",
    "contribution": "研究贡献/创新点",
    # 资源信息
    "data_availability": "数据可用性",
    "code_availability": "代码可用性",
    "code_url": "代码链接",
    "dataset_url": "数据集链接",
    # 元数据
    "research_area": "研究方向",
    "discipline": "学科领域",
}


def _get_paper_collection():
    """获取或创建论文向量 Collection"""
    client = _get_chroma()
    if client is None:
        return None

    try:
        return client.get_or_create_collection(
            name=PAPER_COLLECTION_NAME,
            metadata={"hnsw:space": "cosine"},
        )
    except Exception as e:
        print(f"[VectorStore] 论文 Collection 创建失败: {e}")
        return None


def index_paper_fields(
    paper_id: str,
    title: str = "",
    fields: Optional[Dict[str, str]] = None,
    metadata: Optional[Dict] = None,
    replace: bool = True,
) -> Dict[str, Any]:
    """
    将论文的结构化字段分别索引到向量数据库（每个字段独立成一条记录）。

    这样科研 agent 可以按维度精准检索（如"查找所有理论框架涉及X的论文"）。

    Args:
        paper_id: 论文唯一标识（通常是 zotero_key 或 DOI）
        title: 论文标题（用于 reference）
        fields: 论文字段字典 {field_type: content, ...}
            field_type: title/abstract/keywords/background/theory/method/
                       experiment/conclusion/contribution/data_availability/
                       code_availability/code_url/dataset_url/research_area/discipline
            content: 字段内容文本（如果为空或 None 则跳过该字段）
        metadata: 额外元数据（year, authors, journal, doi 等）
        replace: 是否替换该论文的旧数据

    Returns:
        {"indexed_fields": ["abstract", "theory", ...], "total": N, "chroma_available": bool}
    """
    collection = _get_paper_collection()
    chroma_available = collection is not None

    if collection is None:
        return {"indexed_fields": [], "total": 0, "chroma_available": False}

    try:
        if replace:
            # 删除该论文的旧数据
            try:
                collection.delete(where={"paper_id": paper_id})
            except Exception:
                pass

        if not fields:
            return {"indexed_fields": [], "total": 0, "chroma_available": True}

        indexed_fields = []
        ids = []
        documents = []
        metadatas = []

        base_meta = {
            "paper_id": paper_id,
            "title": title or "",
        }
        if metadata:
            base_meta.update(metadata)

        for field_type, content in fields.items():
            if not content or not content.strip():
                continue  # 跳过空字段

            if field_type not in PAPER_FIELD_TYPES:
                continue  # 跳过未知字段

            # 每个字段单独成一条记录
            doc_id = f"{paper_id}__{field_type}"
            ids.append(doc_id)
            documents.append(content.strip())
            metadatas.append({
                **base_meta,
                "field_type": field_type,
                "field_label": PAPER_FIELD_TYPES.get(field_type, field_type),
            })
            indexed_fields.append(field_type)

        if ids:
            # 分批添加
            batch_size = 100
            for i in range(0, len(ids), batch_size):
                batch_ids = ids[i:i + batch_size]
                batch_docs = documents[i:i + batch_size]
                batch_meta = metadatas[i:i + batch_size]
                collection.add(
                    ids=batch_ids,
                    documents=batch_docs,
                    metadatas=batch_meta,
                )

        print(f"[VectorStore] 论文 {paper_id} 索引完成: {len(indexed_fields)} 个字段")
        return {
            "indexed_fields": indexed_fields,
            "total": len(indexed_fields),
            "chroma_available": True,
        }

    except Exception as e:
        print(f"[VectorStore] 论文索引失败: {e}")
        return {"indexed_fields": [], "total": 0, "chroma_available": chroma_available}


def search_paper_fields(
    query: str,
    field_types: Optional[List[str]] = None,
    top_k: int = 10,
    year_filter: Optional[str] = None,
    author_filter: Optional[str] = None,
) -> List[Dict[str, Any]]:
    """
    按字段类型检索论文（如"查找理论框架中包含X的所有论文"）。

    Args:
        query: 检索查询
        field_types: 要检索的字段类型列表（如 ["theory", "method"]）
                     如果为 None，则检索所有字段
        top_k: 返回结果数量
        year_filter: 年份过滤（如 "2024" 或 ">2020"）
        author_filter: 作者名过滤

    Returns:
        [{"paper_id": ..., "field_type": ..., "content": ..., "score": ..., "title": ..., ...}]
    """
    collection = _get_paper_collection()
    if collection is None:
        return []

    try:
        where_filter = {}
        if field_types:
            where_filter["field_type"] = {"$in": field_types}
        if year_filter:
            where_filter["year"] = year_filter
        if author_filter:
            where_filter["authors"] = {"$contains": author_filter}

        count = collection.count()
        if count == 0:
            return []
        n = max(1, min(top_k, count))

        results = collection.query(
            query_texts=[query],
            n_results=n,
            where=where_filter if where_filter else None,
            include=["documents", "metadatas", "distances"],
        )

        if not results or not results["documents"] or not results["documents"][0]:
            return []

        items = []
        for i, doc in enumerate(results["documents"][0]):
            metadata = results["metadatas"][0][i] if results["metadatas"] else {}
            distance = results["distances"][0][i] if results["distances"] else 0
            score = max(0, 1 - distance)

            items.append({
                "paper_id": metadata.get("paper_id", ""),
                "field_type": metadata.get("field_type", ""),
                "field_label": metadata.get("field_label", ""),
                "content": doc,
                "score": round(score, 4),
                "title": metadata.get("title", ""),
                "year": metadata.get("year", ""),
                "authors": metadata.get("authors", ""),
                "doi": metadata.get("doi", ""),
                "journal": metadata.get("journal", ""),
            })

        return items

    except Exception as e:
        print(f"[VectorStore] 论文检索失败: {e}")
        return []


def delete_paper_from_vector(paper_id: str) -> Dict[str, Any]:
    """从论文向量库中删除指定论文"""
    collection = _get_paper_collection()
    if collection is None:
        return {"deleted": 0}

    try:
        collection.delete(where={"paper_id": paper_id})
        return {"deleted": -1}  # Chroma 不返回删除数量
    except Exception as e:
        print(f"[VectorStore] 删除论文向量失败: {e}")
        return {"deleted": 0}


def get_paper_vector_stats() -> Dict[str, Any]:
    """获取论文向量库统计信息"""
    collection = _get_paper_collection()
    if collection is None:
        return {"available": False, "count": 0, "collection": PAPER_COLLECTION_NAME}

    try:
        count = collection.count()
        # 按 field_type 统计
        field_counts = {}
        for field_type in PAPER_FIELD_TYPES:
            try:
                c = collection.count(where={"field_type": field_type})
                if c > 0:
                    field_counts[field_type] = c
            except Exception:
                pass
        return {
            "available": True,
            "count": count,
            "collection": PAPER_COLLECTION_NAME,
            "field_counts": field_counts,
        }
    except Exception:
        return {"available": False, "count": 0, "collection": PAPER_COLLECTION_NAME}


# ─── 文档导入（同步到 Chroma）────────────────────────────────

def index_document(
    source: str,
    chunks: List[str],
    doc_type: str = "general",
    title: str = "",
    metadata: Optional[Dict] = None,
    replace: bool = True,
) -> Dict[str, Any]:
    """
    导入文档到知识库（SQLite + Chroma）。

    Args:
        source: 文档来源标识
        chunks: 文本分块列表
        doc_type: 文档类型
        title: 文档标题
        metadata: 额外元数据
        replace: 是否替换同来源的旧数据

    Returns:
        {"sqlite_chunks": N, "chroma_chunks": N, "chroma_available": bool}
    """
    from .database import get_kb

    # 1. 写入 SQLite
    kb = get_kb()
    sqlite_count = kb.import_document_chunks(source, chunks, doc_type, title, metadata, replace)

    # 2. 写入 Chroma（如果可用）
    chroma_count = 0
    collection = _get_or_create_collection()
    chroma_available = collection is not None

    if collection is not None:
        try:
            if replace:
                # 删除旧数据
                try:
                    collection.delete(where={"source": source})
                except Exception:
                    pass

            if chunks:
                ids = [f"{source}__chunk_{i}" for i in range(len(chunks))]
                metadatas = []
                for i, chunk in enumerate(chunks):
                    m = {
                        "source": source,
                        "doc_type": doc_type,
                        "title": title,
                        "chunk_index": i,
                    }
                    if metadata:
                        m.update(metadata)
                    metadatas.append(m)

                # 分批添加（Chroma 有 batch size 限制）
                batch_size = 100
                for i in range(0, len(chunks), batch_size):
                    batch_ids = ids[i:i + batch_size]
                    batch_docs = chunks[i:i + batch_size]
                    batch_meta = metadatas[i:i + batch_size]

                    # 确保长度一致
                    min_len = min(len(batch_ids), len(batch_docs), len(batch_meta))
                    batch_ids = batch_ids[:min_len]
                    batch_docs = batch_docs[:min_len]
                    batch_meta = batch_meta[:min_len]

                    if batch_docs:
                        collection.add(
                            ids=batch_ids,
                            documents=batch_docs,
                            metadatas=batch_meta,
                        )
                        chroma_count += len(batch_docs)

        except Exception as e:
            print(f"[VectorStore] Chroma 索引失败: {e}")

    return {
        "sqlite_chunks": sqlite_count,
        "chroma_chunks": chroma_count,
        "chroma_available": chroma_available,
    }


def delete_document(source: str) -> Dict[str, Any]:
    """从知识库删除指定来源的所有文档"""
    from .database import get_kb

    kb = get_kb()

    # SQLite
    cursor = kb.personal.execute("DELETE FROM kb_documents WHERE source = ?", (source,))
    sqlite_deleted = cursor.rowcount
    kb.personal.commit()

    # Chroma
    chroma_deleted = 0
    collection = _get_or_create_collection()
    if collection is not None:
        try:
            collection.delete(where={"source": source})
            chroma_deleted = -1  # Chroma 不返回删除数量
        except Exception:
            pass

    return {
        "sqlite_deleted": sqlite_deleted,
        "chroma_deleted": chroma_deleted,
    }


# ─── 工具函数 ────────────────────────────────────────────────

def _tokenize(text: str) -> List[str]:
    """
    简单分词：英文按空格/标点，中文按单字（简化处理）。

    Phase 2 后可替换为 jieba 等分词器。
    """
    # 提取英文单词（小写）
    english_tokens = re.findall(r'[a-zA-Z]+', text.lower())
    # 提取中文词（按2-4字组合，简化处理）
    chinese_chars = re.findall(r'[\u4e00-\u9fff]+', text)
    chinese_tokens = []
    for segment in chinese_chars:
        if len(segment) <= 4:
            chinese_tokens.append(segment)
        else:
            # 按bigram切分
            for i in range(len(segment) - 1):
                chinese_tokens.append(segment[i:i + 2])

    return english_tokens + chinese_tokens


def is_chroma_available() -> bool:
    """检查 Chroma 是否可用"""
    client = _get_chroma()
    return client is not None


def get_vector_stats() -> Dict[str, Any]:
    """获取向量库统计信息"""
    collection = _get_or_create_collection()
    if collection is None:
        return {"available": False, "count": 0}

    try:
        return {
            "available": True,
            "count": collection.count(),
        }
    except Exception:
        return {"available": False, "count": 0}
