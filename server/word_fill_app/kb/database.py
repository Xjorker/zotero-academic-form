"""
Knowledge Base 数据库层

双层 SQLite 架构：
- personal.db：个人数据（作者信息、项目、专利、数据集 + 文档分块）
- zotero.db：Zotero 同步的论文信息

Schema 通过 PRAGMA table_info 实时派生，永远与数据库同步。

⚠️ 重要安全约束：
- zotero.db 中的表结构由 Zotero 内置 schema 定义，本模块只负责数据同步（添加/更新），
  绝不能对 zotero.db 执行 CREATE TABLE / ALTER TABLE / DROP TABLE 等结构修改操作。
- zotero.db 的数据只能通过 import_zotero_items() 方法添加或更新（Upsert），
  不允许通过 execute_write() 等通用接口执行任意写操作。
- personal.db 的表结构在本模块的 ZOTERO_TABLES / PERSONAL_TABLES 中集中定义，
  初始化时通过 CREATE TABLE IF NOT EXISTS 创建，运行时不再修改。
"""

from __future__ import annotations

import json
import os
import sqlite3
import time
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

# ─── 数据目录 ────────────────────────────────────────────────

DATA_DIR = Path(__file__).parent.parent / "data"


def _ensure_dir():
    """确保数据目录存在"""
    DATA_DIR.mkdir(parents=True, exist_ok=True)


def _db_path(db_name: str) -> str:
    """获取数据库文件路径"""
    _ensure_dir()
    return str(DATA_DIR / db_name)


# ─── Schema 定义（DDL）────────────────────────────────────────

# 个人知识库表 — 与前端 database.ts 的 CREATE TABLE 完全对齐
PERSONAL_TABLES = {
    # 文档分块表 — 存储向量检索用的文本块
    "kb_documents": """
        CREATE TABLE IF NOT EXISTS kb_documents (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            source TEXT NOT NULL,
            doc_type TEXT NOT NULL DEFAULT 'general',
            title TEXT,
            content TEXT NOT NULL,
            chunk_index INTEGER DEFAULT 0,
            metadata TEXT DEFAULT '{}',
            created_at TEXT DEFAULT (datetime('now')),
            updated_at TEXT DEFAULT (datetime('now'))
        )
    """,
}

# ─── 知识库类 ────────────────────────────────────────────────

class KnowledgeBase:
    """知识库管理类 — 封装两个 SQLite 数据库"""

    def __init__(self, personal_path: Optional[str] = None, zotero_path: Optional[str] = None):
        self.personal_path = personal_path or _db_path("personal.db")
        self.zotero_path = zotero_path or _db_path("zotero.db")
        self._personal_conn: Optional[sqlite3.Connection] = None
        self._zotero_conn: Optional[sqlite3.Connection] = None

    # ── 连接管理 ──

    @property
    def personal(self) -> sqlite3.Connection:
        if self._personal_conn is None:
            self._personal_conn = sqlite3.connect(self.personal_path, check_same_thread=False)
            self._personal_conn.row_factory = sqlite3.Row
            self._personal_conn.execute("PRAGMA journal_mode=WAL")
        return self._personal_conn

    @property
    def zotero(self) -> sqlite3.Connection:
        if self._zotero_conn is None:
            self._zotero_conn = sqlite3.connect(self.zotero_path, check_same_thread=False)
            self._zotero_conn.row_factory = sqlite3.Row
            self._zotero_conn.execute("PRAGMA journal_mode=WAL")
        return self._zotero_conn

    def initialize(self):
        """初始化数据库表（仅 personal.db，zotero.db 使用 Zotero 内置表结构）"""
        for name, ddl in PERSONAL_TABLES.items():
            self.personal.execute(ddl)
            print(f"  [KB] 个人表 {name} 就绪")
        self.personal.commit()

    def close(self):
        if self._personal_conn:
            self._personal_conn.close()
            self._personal_conn = None
        if self._zotero_conn:
            self._zotero_conn.close()
            self._zotero_conn = None

    # ── Schema 派生 ──

    def get_schema(self, db: str = "all") -> List[Dict[str, Any]]:
        """
        实时获取数据库 Schema（通过 PRAGMA table_info）。

        Args:
            db: "personal" / "zotero" / "all"

        Returns:
            [{"table": ..., "description": ..., "columns": [...]}]
        """
        TABLE_DESCRIPTIONS = {
            "kb_documents": "导入的文档分块（用于向量检索）",
            "zotero_items": "Zotero 论文条目（标题、DOI、年份等）",
            "zotero_creators": "Zotero 论文作者信息",
            "zotero_tags": "Zotero 论文标签",
        }

        schemas = []
        connections = []
        if db in ("personal", "all"):
            connections.append(("personal", self.personal))
        if db in ("zotero", "all"):
            connections.append(("zotero", self.zotero))

        for db_name, conn in connections:
            # 获取所有表名
            tables = conn.execute(
                "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'"
            ).fetchall()

            for row in tables:
                table_name = row["name"]
                # PRAGMA table_info
                columns = conn.execute(f"PRAGMA table_info(\"{table_name}\")").fetchall()
                col_list = [
                    {
                        "name": col["name"],
                        "type": col["type"],
                        "desc": "",  # 语义描述由上层补充
                    }
                    for col in columns
                ]
                schemas.append({
                    "table": table_name,
                    "db": db_name,
                    "description": TABLE_DESCRIPTIONS.get(table_name, ""),
                    "columns": col_list,
                })

        return schemas

    def get_column_descriptions(self) -> Dict[str, Dict[str, str]]:
        """
        返回每个表中每列的语义描述。
        这是硬编码的业务知识，不会随数据库改变。

        Returns:
            {table_name: {column_name: description}}
        """
        return {
            "kb_documents": {
                "id": "唯一标识",
                "source": "文档来源（文件名/URL）",
                "doc_type": "文档类型（cv/research/general）",
                "title": "文档标题",
                "content": "文本内容",
                "chunk_index": "分块序号",
                "metadata": "元数据（JSON格式）",
                "created_at": "创建时间",
                "updated_at": "更新时间",
            },
            "zotero_items": {
                "id": "唯一标识",
                "zotero_key": "Zotero条目Key",
                "item_type": "条目类型（journalArticle/conferencePaper等）",
                "title": "论文标题",
                "doi": "DOI标识符",
                "year": "发表年份",
                "abstract_note": "摘要",
                "journal": "期刊/会议名称",
                "volume": "卷号",
                "issue": "期号",
                "pages": "页码",
                "publisher": "出版商",
                "issn": "ISSN",
                "language": "语言",
                "date_added": "添加日期",
                "date_modified": "修改日期",
            },
            "zotero_creators": {
                "id": "唯一标识",
                "item_id": "关联的论文ID",
                "creator_type": "创建者类型（author/editor等）",
                "first_name": "名",
                "last_name": "姓",
                "name": "全名（机构作者用这个字段）",
                "author_order": "作者排序",
            },
            "zotero_tags": {
                "id": "唯一标识",
                "item_id": "关联的论文ID",
                "tag": "标签内容",
            },
        }

    # ── SQL 查询执行 ──

    def execute_query(
        self,
        sql: str,
        params: tuple = (),
        db: str = "personal"
    ) -> List[Dict[str, Any]]:
        """
        执行 SELECT 查询并返回结果。

        Args:
            sql: SQL 语句（仅允许 SELECT）
            params: 查询参数
            db: "personal" 或 "zotero"

        Returns:
            查询结果列表（每行为 dict）
        """
        # 安全检查
        sql_upper = sql.upper().strip()
        if not sql_upper.startswith("SELECT"):
            raise ValueError("只允许 SELECT 查询")

        conn = self.personal if db == "personal" else self.zotero

        try:
            cursor = conn.execute(sql, params)
            columns = [desc[0] for desc in cursor.description]
            rows = cursor.fetchall()
            return [dict(zip(columns, row)) for row in rows]
        except sqlite3.Error as e:
            raise ValueError(f"SQL 执行错误: {e}")

    def execute_write(
        self,
        sql: str,
        params: tuple = (),
        db: str = "personal"
    ) -> int:
        """执行写操作，返回 affected rows。

        ⚠️ 安全约束：zotero.db 是 Zotero 内置数据，只能通过
        import_zotero_items() 方法添加/更新数据，不允许通过此接口执行任意写操作。
        """
        if db == "zotero":
            raise ValueError(
                "zotero.db 不允许通过 execute_write 执行写操作。"
                "请使用 import_zotero_items() 方法添加/更新 Zotero 论文数据。"
            )
        conn = self.personal
        cursor = conn.execute(sql, params)
        conn.commit()
        return cursor.rowcount

    # ── 导入数据 ──

    def import_zotero_items(self, items: List[Dict[str, Any]]) -> Dict[str, int]:
        """
        从 Zotero 同步论文数据。

        Args:
            items: Zotero 论文条目列表，每个包含：
                - key: Zotero key
                - itemType
                - title, DOI, year, abstractNote, journal, etc.
                - creators: [{creatorType, firstName, lastName, name}]
                - tags: [{tag}]
                - 🔬 科研深度字段（由外部学术API或前端填充）:
                  keywords, theory, method, experiment, conclusion,
                  contribution, background, dataAvailability, codeAvailability,
                  codeUrl, datasetUrl, researchArea, discipline

        Returns:
            {"items": 导入数量, "creators": 作者数量, "tags": 标签数量}
        """
        stats = {"items": 0, "creators": 0, "tags": 0}

        for item in items:
            zotero_key = item.get("key", "")
            if not zotero_key:
                continue

            # Upsert item
            existing = self.zotero.execute(
                "SELECT id FROM zotero_items WHERE zotero_key = ?", (zotero_key,)
            ).fetchone()

            # 科研深度字段（支持多种命名风格）
            keywords = (item.get("keywords") or item.get("keyword") or
                       item.get("Keywords") or "")
            theory = (item.get("theory") or item.get("Theory") or "")
            method = (item.get("method") or item.get("Method") or
                     item.get("methodology") or item.get("Methodology") or "")
            experiment = (item.get("experiment") or item.get("Experiment") or
                         item.get("results") or item.get("Results") or "")
            conclusion = (item.get("conclusion") or item.get("Conclusion") or "")
            contribution = (item.get("contribution") or item.get("Contribution") or
                           item.get("innovation") or item.get("Innovation") or "")
            background = (item.get("background") or item.get("Background") or
                         item.get("researchBackground") or "")
            data_availability = (item.get("dataAvailability") or
                                item.get("data_availability") or "")
            code_availability = (item.get("codeAvailability") or
                                item.get("code_availability") or "")
            code_url = (item.get("codeUrl") or item.get("code_url") or
                       item.get("github") or item.get("GitHub") or "")
            dataset_url = (item.get("datasetUrl") or item.get("dataset_url") or "")
            research_area = (item.get("researchArea") or item.get("research_area") or
                            item.get("Research Area") or "")
            discipline = (item.get("discipline") or item.get("Discipline") or
                        item.get("field") or item.get("Field") or "")

            if existing:
                item_id = existing["id"]
                self.zotero.execute(
                    """UPDATE zotero_items SET
                    item_type=?, title=?, doi=?, year=?, abstract_note=?,
                    journal=?, volume=?, issue=?, pages=?, publisher=?, issn=?,
                    language=?, date_modified=datetime('now'),
                    keywords=?, theory=?, method=?, experiment=?, conclusion=?,
                    contribution=?, background=?, data_availability=?,
                    code_availability=?, code_url=?, dataset_url=?,
                    research_area=?, discipline=?
                    WHERE zotero_key=?""",
                    (
                        item.get("itemType", ""),
                        item.get("title", ""),
                        item.get("DOI", ""),
                        str(item.get("year", "")),
                        item.get("abstractNote", ""),
                        item.get("journal", ""),
                        item.get("volume", ""),
                        item.get("issue", ""),
                        item.get("pages", ""),
                        item.get("publisher", ""),
                        item.get("ISSN", ""),
                        item.get("language", ""),
                        # 科研深度字段
                        keywords,
                        theory,
                        method,
                        experiment,
                        conclusion,
                        contribution,
                        background,
                        data_availability,
                        code_availability,
                        code_url,
                        dataset_url,
                        research_area,
                        discipline,
                        zotero_key,
                    )
                )
            else:
                cursor = self.zotero.execute(
                    """INSERT INTO zotero_items
                    (zotero_key, item_type, title, doi, year, abstract_note,
                     journal, volume, issue, pages, publisher, issn, language,
                     date_added, date_modified,
                     keywords, theory, method, experiment, conclusion,
                     contribution, background, data_availability,
                     code_availability, code_url, dataset_url,
                     research_area, discipline)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'),
                            ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                    (
                        zotero_key,
                        item.get("itemType", ""),
                        item.get("title", ""),
                        item.get("DOI", ""),
                        str(item.get("year", "")),
                        item.get("abstractNote", ""),
                        item.get("journal", ""),
                        item.get("volume", ""),
                        item.get("issue", ""),
                        item.get("pages", ""),
                        item.get("publisher", ""),
                        item.get("ISSN", ""),
                        item.get("language", ""),
                        # 科研深度字段
                        keywords,
                        theory,
                        method,
                        experiment,
                        conclusion,
                        contribution,
                        background,
                        data_availability,
                        code_availability,
                        code_url,
                        dataset_url,
                        research_area,
                        discipline,
                    )
                )
                item_id = cursor.lastrowid
                stats["items"] += 1

            # 导入作者
            if existing:
                self.zotero.execute("DELETE FROM zotero_creators WHERE item_id = ?", (item_id,))
            creators = item.get("creators", [])
            for order, creator in enumerate(creators):
                self.zotero.execute(
                    """INSERT INTO zotero_creators
                    (item_id, creator_type, first_name, last_name, name, author_order)
                    VALUES (?, ?, ?, ?, ?, ?)""",
                    (
                        item_id,
                        creator.get("creatorType", "author"),
                        creator.get("firstName", ""),
                        creator.get("lastName", ""),
                        creator.get("name", ""),
                        order,
                    )
                )
                stats["creators"] += 1

            # 导入标签
            if existing:
                self.zotero.execute("DELETE FROM zotero_tags WHERE item_id = ?", (item_id,))
            tags = item.get("tags", [])
            for tag_entry in tags:
                tag_text = tag_entry.get("tag", tag_entry) if isinstance(tag_entry, dict) else tag_entry
                self.zotero.execute(
                    "INSERT INTO zotero_tags (item_id, tag) VALUES (?, ?)",
                    (item_id, str(tag_text))
                )
                stats["tags"] += 1

        self.zotero.commit()
        return stats

    def import_document_chunks(
        self,
        source: str,
        chunks: List[str],
        doc_type: str = "general",
        title: str = "",
        metadata: Optional[Dict] = None,
        replace_source: bool = True,
    ) -> int:
        """
        导入文档分块到 kb_documents 表。

        Args:
            source: 文档来源标识（文件名或URL）
            chunks: 文本分块列表
            doc_type: 文档类型（cv/research/general）
            title: 文档标题
            metadata: 额外元数据
            replace_source: 是否替换同一来源的旧分块

        Returns:
            导入的分块数量
        """
        if replace_source:
            self.personal.execute(
                "DELETE FROM kb_documents WHERE source = ?", (source,)
            )

        count = 0
        meta_str = json.dumps(metadata or {}, ensure_ascii=False)
        for idx, chunk in enumerate(chunks):
            self.personal.execute(
                """INSERT INTO kb_documents
                (source, doc_type, title, content, chunk_index, metadata, created_at, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))""",
                (source, doc_type, title, chunk.strip(), idx, meta_str)
            )
            count += 1

        self.personal.commit()
        return count

    def get_document_stats(self) -> Dict[str, Any]:
        """获取知识库统计信息"""
        stats = {}

        # 文档分块统计
        doc_stats = self.personal.execute(
            "SELECT COUNT(*), COUNT(DISTINCT source) FROM kb_documents"
        ).fetchone()
        stats["kb_documents_chunks"] = doc_stats[0]
        stats["kb_documents_sources"] = doc_stats[1]

        # Zotero 论文统计
        item_count = self.zotero.execute("SELECT COUNT(*) FROM zotero_items").fetchone()[0]
        creator_count = self.zotero.execute("SELECT COUNT(*) FROM zotero_creators").fetchone()[0]
        tag_count = self.zotero.execute("SELECT COUNT(*) FROM zotero_tags").fetchone()[0]
        stats["zotero_items"] = item_count
        stats["zotero_creators"] = creator_count
        stats["zotero_tags"] = tag_count

        return stats

    def list_document_sources(self) -> List[Dict[str, Any]]:
        """列出所有已导入的文档来源"""
        rows = self.personal.execute(
            """SELECT source, doc_type, title, COUNT(*) as chunk_count,
               MIN(created_at) as first_imported, MAX(updated_at) as last_updated
               FROM kb_documents GROUP BY source ORDER BY last_updated DESC"""
        ).fetchall()
        return [dict(row) for row in rows]


# ─── 全局单例 ────────────────────────────────────────────────

_kb_instance: Optional[KnowledgeBase] = None


def get_kb() -> KnowledgeBase:
    """获取全局知识库单例"""
    global _kb_instance
    if _kb_instance is None:
        _kb_instance = KnowledgeBase()
    return _kb_instance


def init_kb() -> KnowledgeBase:
    """初始化知识库（建表）并返回实例"""
    kb = get_kb()
    kb.initialize()
    return kb


# ─── 便捷函数 ────────────────────────────────────────────────

def get_kb_schema(db: str = "all") -> List[Dict[str, Any]]:
    """获取知识库 Schema（带列描述）"""
    kb = get_kb()
    schemas = kb.get_schema(db)
    descriptions = kb.get_column_descriptions()

    # 将列描述合并到 Schema 中
    for schema in schemas:
        table_name = schema["table"]
        col_descs = descriptions.get(table_name, {})
        for col in schema["columns"]:
            col["desc"] = col_descs.get(col["name"], "")

    return schemas


def execute_kb_query(
    sql: str,
    params: tuple = (),
    db: str = "personal"
) -> List[Dict[str, Any]]:
    """执行知识库查询"""
    kb = get_kb()
    return kb.execute_query(sql, params, db)


def validate_sql_safety(sql: str) -> Dict[str, Any]:
    """
    验证 SQL 安全性（仅允许 SELECT，且只能查询已知表）。

    Returns:
        {"valid": True/False, "error": "..."}
    """
    if not sql.strip():
        return {"valid": True, "error": None}

    sql_upper = sql.upper().strip()
    dangerous = ["DROP", "DELETE", "INSERT", "UPDATE", "ALTER", "CREATE", "TRUNCATE", "EXEC", "ATTACH"]
    for kw in dangerous:
        if kw in sql_upper:
            return {"valid": False, "error": f"禁止关键字: {kw}"}

    for stmt in sql.split(";"):
        stmt = stmt.strip().upper()
        if stmt and not stmt.startswith("SELECT"):
            return {"valid": False, "error": "只允许 SELECT 查询"}

    # 获取所有允许的表名
    kb = get_kb()
    all_tables = set()
    for schema in kb.get_schema("all"):
        all_tables.add(schema["table"].upper())

    for table in all_tables:
        if table in sql_upper:
            return {"valid": True, "error": None}

    # SELECT 不带表名的简单查询（如 SELECT 1）也是安全的
    if not any(kw in sql_upper for kw in ["FROM", "JOIN"]):
        return {"valid": True, "error": None}

    return {"valid": False, "error": "只能查询知识库中的表"}


def import_zotero_papers(items: List[Dict[str, Any]]) -> Dict[str, int]:
    """从 Zotero 同步论文数据"""
    return get_kb().import_zotero_items(items)


def index_papers_to_vector_db(
    paper_ids: Optional[List[int]] = None,
    replace: bool = True,
) -> Dict[str, Any]:
    """
    将 Zotero 论文库中的论文字段同步到向量数据库。

    从 zotero_items 表读取论文的结构化字段（abstract, keywords, theory,
    method, experiment, conclusion, contribution, background 等），然后索引到
    Chroma 的 zafs_papers collection，支持科研 agent 按维度精准检索。

    Args:
        paper_ids: 要索引的论文 ID 列表（None 表示全部）
        replace: 是否替换已索引的论文数据

    Returns:
        {
            "indexed_papers": N,  # 成功索引的论文数
            "total_fields": M,    # 总共索引的字段数
            "papers_with_abstract": K,  # 有摘要的论文数
            "errors": []          # 错误列表
        }
    """
    from .vector_store import index_paper_fields

    kb = get_kb()

    # 查询论文数据
    if paper_ids:
        placeholders = ",".join(["?"] * len(paper_ids))
        sql = f"""
            SELECT id, zotero_key, title, doi, year, abstract_note,
                   keywords, theory, method, experiment, conclusion,
                   contribution, background, data_availability,
                   code_availability, code_url, dataset_url,
                   research_area, discipline
            FROM zotero_items
            WHERE id IN ({placeholders})
        """
        rows = kb.zotero.execute(sql, paper_ids).fetchall()
    else:
        sql = """
            SELECT id, zotero_key, title, doi, year, abstract_note,
                   keywords, theory, method, experiment, conclusion,
                   contribution, background, data_availability,
                   code_availability, code_url, dataset_url,
                   research_area, discipline
            FROM zotero_items
        """
        rows = kb.zotero.execute(sql).fetchall()

    # 查询作者信息
    creators_sql = """
        SELECT item_id, last_name, first_name
        FROM zotero_creators
        WHERE item_id IN (SELECT id FROM zotero_items)
        ORDER BY item_id, author_order
    """
    creators_rows = kb.zotero.execute(creators_sql).fetchall()
    # 按 item_id 分组
    creators_map: Dict[int, List[str]] = {}
    for row in creators_rows:
        item_id = row["item_id"]
        name = f"{row['first_name']} {row['last_name']}".strip()
        if name:
            creators_map.setdefault(item_id, []).append(name)

    stats = {
        "indexed_papers": 0,
        "total_fields": 0,
        "papers_with_abstract": 0,
        "errors": [],
    }

    for row in rows:
        paper_id = str(row["zotero_key"]) or str(row["id"])
        title = row["title"] or ""

        # 构建字段字典
        fields = {}
        for field_type in [
            "abstract_note", "keywords", "theory", "method",
            "experiment", "conclusion", "contribution", "background",
            "data_availability", "code_availability",
        ]:
            val = row.get(field_type)
            if val and str(val).strip():
                # 映射字段名（abstract_note -> abstract）
                mapped_type = "abstract" if field_type == "abstract_note" else field_type
                fields[mapped_type] = str(val).strip()

        if "abstract" in fields:
            stats["papers_with_abstract"] += 1

        # 跳过完全没有字段的论文
        if not fields:
            continue

        # 获取作者列表
        authors_list = creators_map.get(row["id"], [])
        authors_str = ", ".join(authors_list) if authors_list else ""

        # 准备 metadata
        metadata = {
            "year": str(row["year"]) if row["year"] else "",
            "authors": authors_str,
            "doi": row["doi"] or "",
            "journal": row.get("journal") or "",
            "zotero_id": row["id"],
        }

        try:
            result = index_paper_fields(
                paper_id=paper_id,
                title=title,
                fields=fields,
                metadata=metadata,
                replace=replace,
            )
            if result["total"] > 0:
                stats["indexed_papers"] += 1
                stats["total_fields"] += result["total"]
        except Exception as e:
            stats["errors"].append(f"论文 {paper_id} 索引失败: {e}")

    return stats
