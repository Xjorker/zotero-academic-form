"""
Tool: query_knowledge_base — Text2SQL 查询知识库

Phase 2 实现：
- 真正连接 SQLite 执行 SQL
- Schema 从数据库实时派生（PRAGMA table_info）
- 支持个人知识库 + Zotero 论文库的联合查询
"""

from langchain_core.tools import tool
import json
from typing import Dict, List, Any, Optional

from kb.database import (
    get_kb,
    get_kb_schema as _get_kb_schema_from_db,
    execute_kb_query,
    validate_sql_safety,
)


@tool
def query_knowledge_base(
    sql: str,
    db: str = "auto"
) -> str:
    """执行 SQL 查询知识库（个人数据 / Zotero 论文）。

    可用数据库：
    - "personal": 个人知识库（作者信息、项目、专利、数据集、文档分块）
    - "zotero": Zotero 论文库（论文条目、作者、标签）
    - "auto": 自动判断（默认，根据 SQL 中的表名自动选择）

    使用 get_kb_schema 先查看可用的表和字段，然后编写 SQL 查询。

    Args:
        sql: SELECT 查询语句。例如：
            "SELECT name, affiliation, keywords FROM academic_form_person"
            "SELECT title, year, journal FROM zotero_items WHERE year >= '2020'"
            "SELECT i.title, c.last_name FROM zotero_items i JOIN zotero_creators c ON i.id = c.item_id WHERE c.last_name = 'Wang'"
        db: 目标数据库 "personal" / "zotero" / "auto"

    Returns:
        JSON 字符串，包含查询结果列表。
    """
    try:
        # 验证 SQL 安全性
        validation = validate_sql_safety(sql)
        if not validation["valid"]:
            return json.dumps({
                "success": False,
                "error": f"SQL 不安全: {validation['error']}",
            }, ensure_ascii=False)

        # 自动判断数据库
        if db == "auto":
            sql_upper = sql.upper()
            zotero_tables = ["zotero_items", "zotero_creators", "zotero_tags"]
            if any(t in sql_upper for t in zotero_tables):
                db = "zotero"
            else:
                db = "personal"

        # 执行查询
        results = execute_kb_query(sql, db=db)
        sample_keys = list(results[0].keys())[:8] if results else []
        print(f"[query_knowledge_base] db={db}, total={len(results)}, sample_keys={sample_keys}, sql={sql[:200]}")

        # 明确告诉 LLM 本次查询返回了哪些字段（防止它编造不存在的字段值）
        return json.dumps({
            "success": True,
            "rows": results,
            "total": len(results),
            "db": db,
            "sql": sql,
            # 标注实际返回的字段——只有这些字段的值是可信的
            "returned_fields": sample_keys,
            "note": (
                "只返回了上述 listed 字段的数据。"
                "如果 SQL 没有查 amount/经费/金额 字段，说明 KB 中没有这些数据，填表时相关列必须留空。"
                "不要自行编造任何未在 returned_fields 中出现的字段值。"
            ),
        }, ensure_ascii=False)

    except ValueError as e:
        return json.dumps({
            "success": False,
            "error": str(e),
        }, ensure_ascii=False)
    except Exception as e:
        return json.dumps({
            "success": False,
            "error": f"查询执行错误: {e}",
        }, ensure_ascii=False)


@tool
def get_kb_schema(db: str = "all") -> str:
    """获取知识库的数据库 Schema（所有可用的表和字段描述）。

    Schema 从数据库实时派生（PRAGMA table_info），永远与数据库同步。

    Args:
        db: "personal" / "zotero" / "all"

    Returns:
        JSON 字符串，描述所有可查询的表结构（含列的语义描述）。
    """
    try:
        schemas = _get_kb_schema_from_db(db)

        return json.dumps({
            "success": True,
            "tables": schemas,
            "hint": "使用 query_knowledge_base 执行 SQL 查询这些表。",
        }, ensure_ascii=False)

    except Exception as e:
        return json.dumps({
            "success": False,
            "error": str(e),
        }, ensure_ascii=False)


# 保留 validate_sql 给外部使用（如 API 端点）
def validate_sql(sql: str) -> Dict[str, Any]:
    """验证 SQL 安全性"""
    return validate_sql_safety(sql)
