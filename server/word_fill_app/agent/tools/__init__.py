"""
Agent Tools — LangGraph ReAct Agent 的工具集合

每个工具使用 @tool 装饰器，可被 ToolNode 直接调用。
"""

from .parse_docx import parse_docx, set_parse_state_docx
from .query_kb import query_knowledge_base, get_kb_schema
from .hybrid_rag import hybrid_rag_retrieve
from .fetch_academic import fetch_academic_data, set_academic_state_user_context, set_academic_user_fields
from .fill_docx import fill_docx, set_state_docx_base64, set_academic_paper_total

__all__ = [
    "parse_docx",
    "set_parse_state_docx",
    "query_knowledge_base",
    "get_kb_schema",
    "hybrid_rag_retrieve",
    "fetch_academic_data",
    "set_academic_state_user_context",
    "set_academic_user_fields",
    "fill_docx",
    "set_state_docx_base64",
    "set_academic_paper_total",
]
