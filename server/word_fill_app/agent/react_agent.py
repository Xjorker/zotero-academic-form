"""
LangGraph ReAct Agent - 智能填表Agent

基于LangGraph实现ReAct (Reasoning + Acting)模式的Agent
"""

from typing import Dict, List, Any, Literal, Annotated, Sequence
from dataclasses import dataclass, field
from langgraph.graph import StateGraph, END
import json

from .tools import (
    parse_docx,
    generate_sql_query,
    validate_sql,
    get_schema_definition,
    hybrid_rag_search,
    fetch_academic_papers,
    format_academic_data,
    fill_docx_tables,
    markdown_to_table_data,
    extract_tables_from_text,
    extract_field_requirements
)


@dataclass
class AgentState:
    """Agent状态"""
    messages: List[Dict[str, str]] = field(default_factory=list)
    docx_base64: str = ""
    doc_content: str = ""
    tables: List[Dict] = field(default_factory=list)
    empty_fields: List[str] = field(default_factory=list)
    generated_sql: str = ""
    sql_results: List[Any] = field(default_factory=list)
    rag_results: List[Dict] = field(default_factory=list)
    academic_data: List[Dict] = field(default_factory=list)
    filled_docx_base64: str = ""
    agent_trace: List[Dict] = field(default_factory=list)
    current_step: int = 0
    max_steps: int = 10
    error: str = ""
    success: bool = False


def create_tool(name: str, description: str, func):
    """创建工具定义"""
    async def tool_wrapper(*args, **kwargs):
        try:
            result = func(*args, **kwargs)
            return {"success": True, "result": result}
        except Exception as e:
            return {"success": False, "error": str(e)}

    tool_wrapper.__name__ = name
    tool_wrapper.__doc__ = description
    return tool_wrapper


TOOLS = {
    "parse_docx": {
        "name": "parse_docx",
        "description": "解析DOCX文档，提取需要填写的字段和表格结构",
        "func": lambda base64_content: parse_docx(base64_content)
    },
    "generate_sql": {
        "name": "generate_sql",
        "description": "根据文档字段需求生成SQL查询语句",
        "func": lambda fields, context: generate_sql_query(fields, context)
    },
    "validate_sql": {
        "name": "validate_sql",
        "description": "验证SQL语句的安全性",
        "func": lambda sql: validate_sql(sql)
    },
    "get_schema": {
        "name": "get_schema",
        "description": "获取知识库Schema定义",
        "func": lambda: get_schema_definition()
    },
    "hybrid_rag": {
        "name": "hybrid_rag",
        "description": "混合RAG检索，从向量数据库和BM25检索相关信息",
        "func": lambda query, docs=None, profile=None: hybrid_rag_search(query, docs, profile)
    },
    "fetch_academic": {
        "name": "fetch_academic",
        "description": "从学术数据库获取论文信息",
        "func": lambda author, fields=None: fetch_academic_papers(author, fields)
    },
    "fill_docx": {
        "name": "fill_docx",
        "description": "将数据填充到DOCX文档",
        "func": lambda docx_b64, tables: fill_docx_tables(docx_b64, tables)
    },
    "markdown_to_table": {
        "name": "markdown_to_table",
        "description": "将Markdown表格转换为table_data格式",
        "func": lambda md: markdown_to_table_data(md)
    },
    "format_academic": {
        "name": "format_academic",
        "description": "格式化学术数据",
        "func": lambda papers, fmt="markdown": format_academic_data(papers, fmt)
    }
}


class ReActAgent:
    """ReAct Agent实现"""

    def __init__(self, llm_config: Dict[str, Any] = None):
        self.llm_config = llm_config or {
            "model": "gpt-4",
            "temperature": 0.7
        }
        self.tools = TOOLS

    async def think(self, state: AgentState) -> AgentState:
        """思考下一步行动"""
        state.current_step += 1
        state.messages.append({
            "role": "system",
            "content": f"思考下一步行动... (Step {state.current_step}/{state.max_steps})"
        })

        if state.current_step >= state.max_steps:
            state.messages.append({
                "role": "system",
                "content": "达到最大步数限制，停止执行"
            })
            return state

        return state

    async def act(self, state: AgentState) -> AgentState:
        """执行行动"""
        trace_entry = {"step": state.current_step, "action": "", "result": ""}

        try:
            if not state.doc_content:
                trace_entry["action"] = "parse_docx"
                parse_result = self.tools["parse_docx"]["func"](state.docx_base64)
                if parse_result.get("success"):
                    state.doc_content = parse_result.get("text", "")
                    state.tables = parse_result.get("tables", [])
                    state.empty_fields = parse_result.get("empty_fields", [])
                    state.agent_trace.append({
                        **trace_entry,
                        "result": f"发现 {len(state.tables)} 个表格, {len(state.empty_fields)} 个空字段"
                    })
                return state

            if not state.generated_sql:
                trace_entry["action"] = "generate_sql"
                field_reqs = state.empty_fields or extract_field_requirements(state.doc_content)
                sql_result = self.tools["generate_sql"]["func"](field_reqs, "")
                if sql_result.get("sql"):
                    validation = self.tools["validate_sql"]["func"](sql_result["sql"])
                    if validation.get("valid"):
                        state.generated_sql = sql_result["sql"]
                        state.agent_trace.append({
                            **trace_entry,
                            "result": f"生成SQL: {state.generated_sql[:100]}..."
                        })
                return state

            if not state.rag_results:
                trace_entry["action"] = "hybrid_rag"
                rag_query = " ".join(state.empty_fields[:5]) if state.empty_fields else state.doc_content[:200]
                rag_result = self.tools["hybrid_rag"]["func"](rag_query)
                if rag_result.get("success"):
                    state.rag_results = rag_result.get("results", [])
                    state.agent_trace.append({
                        **trace_entry,
                        "result": f"检索到 {len(state.rag_results)} 条相关信息"
                    })
                return state

            if not state.academic_data and any(
                field in ["论文", "paper", "发表", "publication"]
                for field in state.empty_fields
            ):
                trace_entry["action"] = "fetch_academic"
                author_name = ""
                for msg in state.messages:
                    if "author" in msg.get("content", "").lower():
                        author_name = msg["content"]
                        break
                academic_result = self.tools["fetch_academic"]["func"](author_name or "unknown")
                if academic_result.get("success"):
                    state.academic_data = academic_result.get("papers", [])
                    state.agent_trace.append({
                        **trace_entry,
                        "result": f"获取 {len(state.academic_data)} 篇学术论文"
                    })
                return state

            if state.generated_sql and not state.sql_results:
                state.sql_results = [{"sql": state.generated_sql, "note": "SQL已生成，等待前端执行"}]
                trace_entry["action"] = "query_kb"
                state.agent_trace.append({
                    **trace_entry,
                    "result": "SQL查询已准备好，等待前端执行"
                })
                return state

            if not state.filled_docx_base64 and (state.rag_results or state.sql_results):
                trace_entry["action"] = "fill_docx"

                table_data = []
                if state.sql_results and state.generated_sql:
                    for sql_result in state.sql_results:
                        if "data" in sql_result:
                            table_data.append({
                                "headers": list(sql_result["data"][0].keys()) if sql_result["data"] else [],
                                "rows": [[v for v in row.values()] for row in sql_result["data"]]
                            })

                if state.academic_data:
                    table_data.append({
                        "headers": ["标题", "年份", "期刊", "作者"],
                        "rows": [
                            [
                                p.get("title", ""),
                                p.get("year", ""),
                                p.get("venue", ""),
                                ", ".join(p.get("authors", [])[:3])
                            ]
                            for p in state.academic_data[:10]
                        ]
                    })

                if table_data:
                    fill_result = self.tools["fill_docx"]["func"](state.docx_base64, table_data)
                    if fill_result.get("success"):
                        state.filled_docx_base64 = fill_result.get("docx_base64", "")
                        state.agent_trace.append({
                            **trace_entry,
                            "result": f"文档填充完成，填充了 {fill_result.get('filled_count', 0)} 项"
                        })
                        state.success = True

        except Exception as e:
            state.error = str(e)
            state.agent_trace.append({
                **trace_entry,
                "result": f"错误: {str(e)[:100]}"
            })

        return state

    async def run(self, initial_state: Dict) -> AgentState:
        """运行Agent"""
        state = AgentState(**initial_state)

        while state.current_step < state.max_steps and not state.success:
            state = await self.think(state)
            if state.current_step >= state.max_steps:
                break
            state = await self.act(state)

            if state.error and state.current_step >= 3:
                break

        return state


def create_agent(llm_config: Dict[str, Any] = None) -> ReActAgent:
    """创建Agent实例"""
    return ReActAgent(llm_config)


agent_executor = ReActAgent()
