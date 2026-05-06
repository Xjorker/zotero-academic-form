"""
Agent State — LangGraph ReAct Agent 的状态定义

使用 TypedDict 定义 Agent 在图中流转的完整状态。
"""

from __future__ import annotations

import operator
from typing import (
    Annotated,
    Any,
    Dict,
    List,
    Literal,
    Optional,
    Sequence,
    TypedDict,
)

from langchain_core.messages import BaseMessage


# ─── 核心状态 ────────────────────────────────────────────

class AgentInput(TypedDict, total=False):
    """Agent 的输入参数（从 API 请求传入）"""
    docx_base64: str
    """待填写的 DOCX 文件（Base64 编码）"""

    session_id: str
    """会话 ID，用于记忆和日志"""

    llm_config: Dict[str, Any]
    """LLM 配置：model, temperature, api_key 等"""

    user_context: str
    """用户额外提供的上下文（如作者姓名、机构等）"""

    max_steps: int
    """最大执行步数，默认 10"""

    sources: List[str]
    """启用的数据源：kb / rag / api"""


class AgentState(AgentInput):
    """Agent 在 LangGraph 图中流转的完整状态"""

    # ── LangGraph 消息列表（自动累积，用 operator.add reducer）──
    messages: Annotated[Sequence[BaseMessage], operator.add]

    # ── 文档解析结果 ──
    doc_text: str
    """从 DOCX 提取的全文（Markdown 格式）"""

    doc_tables: List[Dict[str, Any]]
    """DOCX 中的表格信息列表
    每项: {"index": int, "headers": List[str], "empty_columns": List[int], "data_rows": List[List[str]]}
    """

    empty_fields: List[str]
    """需要填写的空字段名称列表"""

    # ── 知识库查询 ──
    kb_sql: str
    """Agent 生成的 SQL 查询语句"""

    kb_results: List[Dict[str, Any]]
    """SQL 查询返回的结果集"""

    # ── RAG 检索 ──
    rag_results: List[Dict[str, Any]]
    """混合检索返回的结果列表
    每项: {"text": str, "score": float, "source": str}
    """

    # ── 学术 API ──
    academic_data: List[Dict[str, Any]]
    """从 DBLP/Semantic Scholar 获取的论文数据
    每项: {"title": str, "year": str, "venue": str, "authors": List[str]}
    """

    # ── 最终输出 ──
    filled_docx_base64: str
    """填充后的 DOCX 文件（Base64 编码）"""

    fill_tables_markdown: str
    """Agent 决策后输出的 Markdown 表格数据（用于填表）"""

    # ── 执行控制 ──
    current_step: int
    """当前执行步数"""

    max_steps: int
    """最大步数限制"""

    # ── 运行结果 ──
    success: bool
    """是否成功完成填表"""

    error: str
    """错误信息"""

    # ── Agent 推理轨迹（用于前端展示）──
    agent_trace: List[Dict[str, Any]]
    """每步的执行记录
    每项: {"step": int, "action": str, "tool": str, "input": Any, "output": str, "duration_ms": float}
    """
