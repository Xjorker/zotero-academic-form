"""
Knowledge Base 模块

两层知识库架构：
1. 个人知识库（SQLite）— 用户手动维护的个人数据（项目、专利、数据集、作者信息）
2. Zotero 论文库（SQLite）— 从 Zotero 同步的论文信息

两个 SQLite 数据库可以独立查询，也可以联合查询。
Schema 通过 PRAGMA 实时派生，无需手动维护。
"""

from .database import (
    KnowledgeBase,
    get_kb,
    init_kb,
    get_kb_schema,
    execute_kb_query,
    import_author_info,
    import_projects,
    import_patents,
    import_datasets,
    import_zotero_papers,
    index_papers_to_vector_db,
)

from .vector_store import (
    index_document,
    index_paper_fields,
    search_paper_fields,
    delete_document,
    delete_paper_from_vector,
    hybrid_search,
    bm25_search,
    chroma_search,
    is_chroma_available,
    get_vector_stats,
    get_paper_vector_stats,
    PAPER_FIELD_TYPES,
)

__all__ = [
    # Database
    "KnowledgeBase",
    "get_kb",
    "init_kb",
    "get_kb_schema",
    "execute_kb_query",
    "import_author_info",
    "import_projects",
    "import_patents",
    "import_datasets",
    "import_zotero_papers",
    "index_papers_to_vector_db",
    # Vector Store
    "index_document",
    "index_paper_fields",
    "search_paper_fields",
    "delete_document",
    "delete_paper_from_vector",
    "hybrid_search",
    "bm25_search",
    "chroma_search",
    "is_chroma_available",
    "get_vector_stats",
    "get_paper_vector_stats",
    "PAPER_FIELD_TYPES",
]
