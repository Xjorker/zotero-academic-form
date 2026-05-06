"""
Agent API 路由 — LangGraph Agent 的 HTTP 端点

端点：
- POST /agent/fill         — Agent 智能填表（核心端点）
- POST /agent/schema       — 获取知识库 Schema
- POST /agent/sql/validate — 验证 SQL 安全性
- GET  /agent/memory/{id}  — 获取会话记忆
- DELETE /agent/memory/{id} — 清除会话记忆
"""

from __future__ import annotations

import base64
import json
import time
import uuid
import os
import tempfile
from typing import Any, Dict, Optional

from fastapi import APIRouter, Request, HTTPException
from langchain_core.messages import HumanMessage, SystemMessage

from agent.graph import create_agent_graph
from agent.tools.query_kb import validate_sql
from kb import get_kb_schema
from agent.memory import memory_store

# ─── 内置临时文件管理（5分钟有效期）───
# 避免从 main.py 导入造成循环依赖

_TEMP_FILES: Dict[str, dict] = {}
_TEMP_EXPIRY_SECONDS = 300  # 5分钟


def _create_temp_download(content: bytes, original_filename: str) -> str:
    """创建临时文件并返回下载路径"""
    # 清理过期文件
    now = time.time()
    expired_tokens = [t for t, info in _TEMP_FILES.items() if info["expires_at"] < now]
    for t in expired_tokens:
        try:
            if os.path.exists(_TEMP_FILES[t]["filepath"]):
                os.remove(_TEMP_FILES[t]["filepath"])
        except Exception:
            pass
        del _TEMP_FILES[t]

    token = str(uuid.uuid4())
    ext = os.path.splitext(original_filename)[1] or ".docx"
    filepath = os.path.join(tempfile.gettempdir(), f"zotero_agent_{token}{ext}")
    with open(filepath, "wb") as f:
        f.write(content)
    _TEMP_FILES[token] = {"filepath": filepath, "filename": original_filename, "expires_at": now + _TEMP_EXPIRY_SECONDS}
    return token


def _get_temp_download(token: str) -> Optional[dict]:
    """获取临时文件信息"""
    info = _TEMP_FILES.get(token)
    if not info or info["expires_at"] < time.time():
        if token in _TEMP_FILES:
            try:
                os.remove(info["filepath"])
            except Exception:
                pass
            del _TEMP_FILES[token]
        return None
    return info


def _summarize_tool_payload(payload: Dict[str, Any]) -> str:
    """将工具返回结果压缩成可读日志，便于查看数据来源。"""
    if not isinstance(payload, dict):
        return "非结构化工具输出"

    if payload.get("papers") is not None or payload.get("source"):
        return (
            f"学术API source={payload.get('source', 'unknown')}, "
            f"author={payload.get('author', '')}, total={payload.get('total', len(payload.get('papers', [])))}"
        )

    if payload.get("db") and payload.get("rows") is not None:
        sample_keys = list(payload.get("rows", [{}])[0].keys())[:8] if payload.get("rows") else []
        return f"知识库 db={payload.get('db')}, total={payload.get('total', 0)}, sample_keys={sample_keys}"

    if payload.get("results") is not None and "chroma_available" in payload:
        top_sources = [r.get("source", "") for r in payload.get("results", [])[:3]]
        return f"RAG total={payload.get('total', 0)}, top_sources={top_sources}"

    if payload.get("docx_base64"):
        return f"填表完成 filled_count={payload.get('filled_count', 0)}"

    if payload.get("error"):
        return f"错误: {str(payload.get('error', ''))[:200]}"

    keys = list(payload.keys())[:8]
    return f"工具输出 keys={keys}"


def _print_tool_source_summary(messages: list):
    """打印一次 Agent 本轮实际使用的数据来源摘要。"""
    from langchain_core.messages import ToolMessage

    print("[Agent /fill] --- 数据来源摘要 ---")
    tool_idx = 0
    for msg in messages:
        if not isinstance(msg, ToolMessage):
            continue
        tool_idx += 1
        try:
            payload = json.loads(msg.content) if isinstance(msg.content, str) else msg.content
        except Exception:
            payload = {"raw": str(msg.content)[:200]}
        summary = _summarize_tool_payload(payload if isinstance(payload, dict) else {"raw": payload})
        print(f"[Agent /fill] Tool#{tool_idx}: {summary}")
    if tool_idx == 0:
        print("[Agent /fill] Tool#0: 本轮未记录到工具输出")


router = APIRouter(prefix="/agent", tags=["agent"])



# ─── LLM 工厂 ──────────────────────────────────────────────

def _create_llm(llm_config: Dict[str, Any]):
    """根据配置创建 LLM 实例"""
    model = llm_config.get("model", "gpt-4")
    api_key = llm_config.get("api_key", "")
    base_url = llm_config.get("base_url", "")
    temperature = llm_config.get("temperature", 0.1)
    max_tokens = llm_config.get("max_tokens", 0)  # 0 = use model default

    model_lower = model.lower()
    use_proxy = bool(base_url)  # 是否使用代理服务

    # OpenAI / 兼容 API
    if "gpt" in model_lower or "deepseek" in model_lower or base_url:
        from langchain_openai import ChatOpenAI
        kwargs = {
            "model": model,
            "temperature": temperature,
        }
        if api_key:
            kwargs["api_key"] = api_key
        if base_url:
            kwargs["base_url"] = base_url
        if max_tokens and max_tokens > 0:
            kwargs["max_tokens"] = max_tokens
        else:
            # 默认使用较大的输出限制，确保大量论文数据不截断
            # 45条论文的完整 Markdown 表格（每条约240 tokens）+ 其他表格（≈5k）+ 映射说明 ≈ 需要 20k+ tokens
            # 考虑 mimo-v2-flash 等小模型分块输出，设置充足的上限
            kwargs["max_tokens"] = 50000
        llm = ChatOpenAI(**kwargs)

        if use_proxy:
            # ── 代理服务兼容性补丁 ──
            # 禁用 Responses API（代理服务通常不支持）
            llm.use_responses_api = False

            # Patch _generate：某些代理对特定模型（如 codex 系列）返回
            # 非标准 Chat Completions 响应，raw_response.parse() 返回 str 而非 Pydantic 对象
            _original_generate = llm._generate

            def _patched_generate(messages, stop=None, run_manager=None, **kwargs):
                try:
                    return _original_generate(messages, stop=stop, run_manager=run_manager, **kwargs)
                except (AttributeError, TypeError) as e:
                    err_msg = str(e)
                    if isinstance(e, AttributeError) and ("model_dump" in err_msg or "error" in err_msg):
                        raise ValueError(
                            f"代理服务对模型 '{model}' 返回了不兼容的响应格式。"
                            f"这通常意味着该模型在代理服务上需要使用 Responses API，"
                            f"但代理服务对此格式的支持不完整。\n"
                            f"建议：请换用其他模型（如 gpt-4o、gpt-4-turbo、deepseek-chat、claude-3.5-sonnet 等）。"
                        ) from e
                    raise

            llm._generate = _patched_generate

        return llm

    # Anthropic Claude
    elif "claude" in model_lower:
        from langchain_anthropic import ChatAnthropic
        kwargs = {
            "model": model,
            "temperature": temperature,
        }
        if api_key:
            kwargs["api_key"] = api_key
        return ChatAnthropic(**kwargs)

    # 默认使用 OpenAI
    else:
        from langchain_openai import ChatOpenAI
        kwargs = {
            "model": model,
            "temperature": temperature,
        }
        if api_key:
            kwargs["api_key"] = api_key
        if base_url:
            kwargs["base_url"] = base_url
        if max_tokens and max_tokens > 0:
            kwargs["max_tokens"] = max_tokens
        else:
            # 默认使用较大的输出限制，确保大量论文数据不截断
            kwargs["max_tokens"] = 50000
        llm = ChatOpenAI(**kwargs)
        if use_proxy:
            llm.use_responses_api = False
            _original_generate = llm._generate

            def _patched_generate(messages, stop=None, run_manager=None, **kwargs):
                try:
                    return _original_generate(messages, stop=stop, run_manager=run_manager, **kwargs)
                except (AttributeError, TypeError) as e:
                    err_msg = str(e)
                    if isinstance(e, AttributeError) and ("model_dump" in err_msg or "error" in err_msg):
                        raise ValueError(
                            f"代理服务对模型 '{model}' 返回了不兼容的响应格式。"
                            f"请换用其他模型（如 gpt-4o、deepseek-chat、claude-3.5-sonnet 等）。"
                        ) from e
                    raise

            llm._generate = _patched_generate

        return llm


# ─── 核心端点 ──────────────────────────────────────────────

@router.post("/fill")
async def agent_fill(request: Request):
    """
    Agent 智能填表

    请求体（JSON）:
    {
        "docx_base64": "<base64>",       // 必填：DOCX 文件
        "session_id": "user_xxx",        // 可选：会话 ID
        "user_context": "张三, 清华大学",  // 可选：用户上下文
        "llm_config": {                   // 可选：LLM 配置
            "model": "gpt-4",
            "api_key": "...",
            "base_url": "...",
            "temperature": 0.1
        },
        "max_steps": 20,                 // 可选：最大步数（默认 20）
        "sources": ["kb", "rag", "api"], // 可选：启用数据源
        "config": {                       // 可选：兼容前端 config 嵌套格式
            "max_steps": 20,
            "sources": ["kb", "rag", "api"]
        }
    }
    """
    try:
        # 解析请求
        content_type = request.headers.get("content-type", "")
        if "application/json" in content_type:
            body = await request.json()
        else:
            form = await request.form()
            body = {
                "docx_base64": form.get("docx_base64", ""),
                "session_id": form.get("session_id", "default"),
                "user_context": form.get("user_context", ""),
                "llm_config": json.loads(form.get("llm_config", "{}")),
                "max_steps": int(form.get("max_steps", 20)),
                "sources": json.loads(form.get("sources", '["kb","rag","api"]')),
            }

        docx_base64 = body.get("docx_base64", "")
        if not docx_base64:
            return {"success": False, "error": "缺少 docx_base64 参数"}

        session_id = body.get("session_id", "default")
        user_context = body.get("user_context", "")
        llm_config = body.get("llm_config", {})

        # 兼容两种传法：顶层 max_steps 或 config.max_steps（前端传法）
        config_obj = body.get("config", {})
        max_steps = (
            body.get("max_steps")
            or config_obj.get("max_steps")
            or 20
        )
        sources = (
            body.get("sources")
            or config_obj.get("sources")
            or ["kb", "rag", "api"]
        )

        print(f"[Agent /fill] session={session_id}, model={llm_config.get('model', 'default')}, max_steps={max_steps}, docx_base64_len={len(docx_base64)}, user_context='{user_context}'")

        # 创建 LLM
        llm = _create_llm(llm_config)

        # 创建图
        graph = create_agent_graph(llm)

        # 构建初始状态
        initial_state: Dict[str, Any] = {
            "docx_base64": docx_base64,
            "session_id": session_id,
            "user_context": user_context,
            "max_steps": max_steps,
            "sources": sources,
            "messages": [],
            "doc_text": "",
            "doc_tables": [],
            "empty_fields": [],
            "kb_sql": "",
            "kb_results": [],
            "rag_results": [],
            "academic_data": [],
            "filled_docx_base64": "",
            "fill_tables_markdown": "",
            "current_step": 0,
            "success": False,
            "error": "",
            "agent_trace": [],
        }

        # 运行图
        start_time = time.time()
        config = {"configurable": {"thread_id": session_id}}

        final_state = None
        async for event in graph.astream(initial_state, config=config, stream_mode="updates"):
            # event 是一个 dict: {"node_name": state_update}
            for node_name, state_update in event.items():
                final_state = state_update
                # 将更新合并到 initial_state（用于追踪）
                for k, v in state_update.items():
                    if k == "messages":
                        initial_state[k] = initial_state.get(k, []) + list(v)
                    elif isinstance(v, (int, float, str, bool)) or v is None:
                        initial_state[k] = v

        elapsed = time.time() - start_time
        _print_tool_source_summary(initial_state.get("messages", []))

        # 从最终状态中提取结果
        # 查找 fill_docx 的返回（ToolMessage 中包含 docx_base64）
        filled_docx_base64 = initial_state.get("filled_docx_base64", "")
        success = False


        # 从消息历史中查找 fill_docx 的结果
        last_error = ""
        mapping_summary = ""
        word_headers_summary = []
        for msg in reversed(initial_state.get("messages", [])):
            from langchain_core.messages import ToolMessage
            if isinstance(msg, ToolMessage):
                try:
                    content = json.loads(msg.content) if isinstance(msg.content, str) else msg.content
                    if isinstance(content, dict):
                        if content.get("success") and content.get("docx_base64"):
                            filled_docx_base64 = content["docx_base64"]
                            success = True
                            mapping_summary = content.get("mapping_summary", "")
                            word_headers_summary = content.get("word_headers_summary", [])
                            break
                        elif content.get("error"):
                            last_error = str(content.get("error", ""))[:300]
                except (json.JSONDecodeError, TypeError):
                    pass

        # 如果没有找到成功结果，输出调试信息
        if not success:
            msg_count = len(initial_state.get("messages", []))
            trace_count = len(initial_state.get("agent_trace", []))
            print(f"[Agent /fill] 未成功完成: messages={msg_count}, trace={trace_count}, last_error='{last_error}'")
            if last_error:
                print(f"[Agent /fill] 工具错误: {last_error}")

        # 保存会话记忆
        memory_store.save_session(session_id, [
            {"role": "user", "content": f"填表请求 | user_context={user_context}"},
            {"role": "assistant", "content": f"完成 | success={success} | 耗时={elapsed:.1f}s"},
        ])

        # 成功时创建临时文件，返回下载 URL
        download_url = ""
        if success and filled_docx_base64:
            try:
                file_bytes = base64.b64decode(filled_docx_base64)
                filename = f"{user_context or 'academic_form'}_filled.docx".replace(" ", "_")
                token = _create_temp_download(file_bytes, filename)
                download_url = f"/agent/download/{token}"
                print(f"[Agent /fill] 下载链接: {download_url}")
            except Exception as e:
                print(f"[Agent /fill] 创建临时文件失败: {e}")

        return {
            "success": success,
            "docx_base64": filled_docx_base64 or "",
            "download_url": download_url,
            "agent_trace": initial_state.get("agent_trace", []),
            "session_id": session_id,
            "elapsed_seconds": round(elapsed, 2),
            "steps": initial_state.get("current_step", 0),
            "error": last_error if not success else initial_state.get("error", ""),
            "mapping_summary": mapping_summary,
            "word_headers_summary": word_headers_summary,
        }

    except Exception as e:
        import traceback
        print(f"[Agent /fill] 错误: {e}")
        traceback.print_exc()
        return {
            "success": False,
            "error": str(e),
            "agent_trace": [],
            "docx_base64": "",
        }


# ─── 辅助端点 ──────────────────────────────────────────────

@router.post("/schema")
async def get_schema(request: Request):
    """获取知识库 Schema（从数据库实时派生）"""
    body = await request.json() if request.headers.get("content-type", "").startswith("application/json") else {}
    db = body.get("db", "all")
    try:
        schemas = get_kb_schema(db)
        return {"success": True, "tables": schemas}
    except Exception as e:
        return {"success": False, "error": str(e)}


@router.post("/sql/validate")
async def validate_sql_endpoint(request: Request):
    """验证 SQL 安全性"""
    body = await request.json()
    sql = body.get("sql", "")
    result = validate_sql(sql)
    return {"success": result.get("valid", False), "valid": result.get("valid"), "error": result.get("error")}


@router.get("/memory/{session_id}")
async def get_memory(session_id: str):
    """获取会话记忆"""
    messages = memory_store.load_session(session_id)
    return {"success": True, "messages": messages or [], "session_id": session_id}


@router.delete("/memory/{session_id}")
async def clear_memory(session_id: str):
    """清除会话记忆"""
    memory_store.clear_session(session_id)
    return {"success": True, "message": f"会话 {session_id} 已清除"}


@router.get("/download/{token}")
async def agent_download(token: str):
    """Agent 临时文件下载端点（5分钟有效期）"""
    info = _get_temp_download(token)
    if not info:
        from fastapi.responses import JSONResponse
        return JSONResponse(status_code=404, content={"error": "File not found or expired"})
    from fastapi.responses import FileResponse
    print(f"[Agent download] 发送文件: {info['filename']} (token: {token})")
    return FileResponse(
        path=info["filepath"],
        filename=info["filename"],
        media_type="application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    )
