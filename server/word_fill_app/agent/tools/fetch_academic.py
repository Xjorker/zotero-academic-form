"""
Tool: fetch_academic — 从学术 API 获取论文/作者数据

调用部署在远程服务器的学术成果 API（81.70.12.153:8060）。
接口与旧版前端 academicApi.ts 保持一致：
  POST /agent/run-academic-form
  Body: { "author_name": "...", "user_fields": { "论文名称": "paper.title", ... } }
  Response: { "papers": [...] }
"""

from langchain_core.tools import tool
import json
import urllib.request
import urllib.parse
from typing import Dict, List, Any, Optional

# ─── 远程学术 API 配置 ───────────────────────────────────
ACADEMIC_API_BASE = "http://81.70.12.153:8060"
ACADEMIC_API_ENDPOINT = f"{ACADEMIC_API_BASE}/agent/run-academic-form"

# ─── 白名单字段映射（严格白名单 — 用户自定义版本）───
# 从文档列名到学术 API 字段路径的映射
# ⚠️ 此白名单为严格版本：只有明确在此列表中的字段才会被用于 API 查询
# 原文档表头通过模糊匹配映射到此白名单的 key，再转换为对应的 API 字段
USER_FIELDS_WHITELIST: Dict[str, str] = {
    # 📄 基础论文信息
    "论文名称": "paper.title",
    "论文题目": "paper.title",
    "题目": "paper.title",
    "名称": "paper.title",
    "标题": "paper.title",
    "title": "paper.title",
    "publication": "paper.title",
    "DOI": "paper.doi",
    "doi": "paper.doi",
    "发表年份": "paper.year",
    "年份": "paper.year",
    "year": "paper.year",
    "发表时间": "paper.year",
    "出版日期": "paper.year",
    "日期": "paper.year",
    "论文类型": "paper.type",
    "类型": "paper.type",
    "论文语言": "paper.language",
    "语言": "paper.language",

    # 👤 作者相关
    "所有著作者姓名及排序": "paper.authors",
    "所有著作者姓名及排序；如有通讯作者请著名": "paper.authors",
    "作者列表": "paper.authors",
    "作者": "paper.authors",
    "authors": "paper.authors",
    "全部作者": "paper.authors",
    "论文作者": "paper.authors",
    "本人在作者列表中的排序": "paper.author_order",
    "本人排序": "paper.author_order",
    "作者排序": "paper.author_order",
    "作者排名": "paper.author_order",
    "排名": "paper.author_order",
    "author_order": "paper.author_order",
    "author rank": "paper.author_order",
    "本人机构": "paper.author_affiliation",
    "本人所在机构": "paper.author_affiliation",
    "author affiliation": "paper.author_affiliation",
    "affiliation": "paper.author_affiliation",
    "全部作者机构": "paper.all_affiliations",
    "作者机构": "paper.all_affiliations",
    "机构": "paper.all_affiliations",
    "all affiliations": "paper.all_affiliations",

    # 📘 期刊/会议
    "期刊/会议名称": "paper.journal.name",
    "期刊名称": "paper.journal.name",
    "会议名称": "paper.journal.name",
    "期刊": "paper.journal.name",
    "会议": "paper.journal.name",
    "发表期刊": "paper.journal.name",
    "刊物名称": "paper.journal.name",
    "出版或发表时间、出版单位或发表刊物名称、期号及页码": "paper.journal.name",  # 复合字段，提取期刊名
    "journal": "paper.journal.name",
    "venue": "paper.journal.name",
    "source": "paper.journal.name",
    "出版商": "paper.journal.publisher",
    "publisher": "paper.journal.publisher",
    "ISSN（印刷）": "paper.journal.issn.print",
    "ISSN（电子）": "paper.journal.issn.electronic",
    "ISSN": "paper.journal.issn.print",
    "卷号": "paper.journal.volume",
    "volume": "paper.journal.volume",
    "期号": "paper.journal.issue",
    "issue": "paper.journal.issue",
    "页码": "paper.journal.pages",
    "pages": "paper.journal.pages",

    # 🌍 合作与指标
    "是否国际合著": "paper.is_international",
    "国际合著": "paper.is_international",
    "引用次数": "paper.metrics.is_referenced_by_count",
    "被引次数": "paper.metrics.is_referenced_by_count",
    "citations": "paper.metrics.is_referenced_by_count",
    "参考文献数": "paper.metrics.reference_count",
    "reference count": "paper.metrics.reference_count",

    # 🔬 科研深度索引字段（为科研agent提供检索基础）
    # 摘要/Abstract
    "摘要": "paper.abstract",
    "abstract": "paper.abstract",
    "论文摘要": "paper.abstract",
    "研究摘要": "paper.abstract",
    "Abstract Note": "paper.abstract",

    # 关键词/Keywords
    "关键词": "paper.keywords",
    "keywords": "paper.keywords",
    "研究关键词": "paper.keywords",
    "keyword": "paper.keywords",

    # 研究背景/Background
    "研究背景": "paper.background",
    "背景": "paper.background",
    "background": "paper.background",
    "研究动机": "paper.background",

    # 研究理论/Theory
    "理论": "paper.theory",
    "研究理论": "paper.theory",
    "理论框架": "paper.theory",
    "理论模型": "paper.theory",
    "theory": "paper.theory",
    "理论基础": "paper.theory",

    # 研究方法/Method
    "研究方法": "paper.method",
    "方法": "paper.method",
    "method": "paper.method",
    "方法论": "paper.method",
    "技术路线": "paper.method",
    "实验方法": "paper.method",
    "methodology": "paper.method",

    # 实验/Experiment
    "实验": "paper.experiment",
    "实验结果": "paper.experiment",
    "实验设计": "paper.experiment",
    "experiment": "paper.experiment",
    "results": "paper.experiment",
    "研究结果": "paper.experiment",
    "数值实验": "paper.experiment",

    # 结论/Conclusion
    "结论": "paper.conclusion",
    "研究结论": "paper.conclusion",
    "conclusion": "paper.conclusion",
    "研究贡献": "paper.contribution",
    "主要贡献": "paper.contribution",
    "contribution": "paper.contribution",
    "创新点": "paper.contribution",

    # 数据与代码
    "数据可用性": "paper.data_availability",
    "data availability": "paper.data_availability",
    "代码可用性": "paper.code_availability",
    "code availability": "paper.code_availability",
    "开源链接": "paper.code_url",
    "code url": "paper.code_url",
    "数据集链接": "paper.dataset_url",
    "dataset url": "paper.dataset_url",

    # 额外元数据
    "电子版链接": "paper.ee",
    "ee": "paper.ee",
    "dblp_url": "paper.url",
    "dblp key": "paper.dblp_key",
    "研究方向": "paper.research_area",
    "research area": "paper.research_area",
    "学科领域": "paper.discipline",
    "discipline": "paper.discipline",
}

# 兼容旧代码
DEFAULT_USER_FIELDS = USER_FIELDS_WHITELIST

# ─── 模块级状态注入（与 parse_docx/fill_docx 同样模式）───
_academic_state_user_context = ""

# 由 graph.py tools_wrapper 注入的动态字段映射
# 优先级高于 DEFAULT_USER_FIELDS（当非空时使用，为空时 fallback 到 DEFAULT_USER_FIELDS）
_dynamic_user_fields: Dict[str, str] = {}


def set_academic_state_user_context(ctx: str):
    """由 tools_wrapper 在工具执行前调用，注入 user_context"""
    global _academic_state_user_context
    _academic_state_user_context = ctx or ""


def set_academic_user_fields(user_fields: Dict[str, str]):
    """
    由 graph.py tools_wrapper 在 fetch_academic_data 执行前调用，
    注入根据 parse_docx 结果动态裁剪的字段映射。

    当此值为非空字典时，fetch_academic_data 优先使用它替代 DEFAULT_USER_FIELDS。
    """
    global _dynamic_user_fields
    _dynamic_user_fields = user_fields or {}


def _resolve_user_fields() -> Dict[str, str]:
    """
    解析实际使用的 user_fields：
    优先使用动态注入的字段（由 parse_docx 表头裁剪），
    如果没有则 fallback 到 DEFAULT_USER_FIELDS。
    """
    if _dynamic_user_fields:
        print(
            f"[fetch_academic] 使用动态 user_fields ({len(_dynamic_user_fields)} 个字段)，"
            f"替代 DEFAULT_USER_FIELDS ({len(DEFAULT_USER_FIELDS)} 个字段)"
        )
        return _dynamic_user_fields
    return DEFAULT_USER_FIELDS


def _call_remote_academic_api(author_name: str, user_fields: Dict[str, str]) -> List[Dict]:
    """
    调用远程学术成果 API。

    Args:
        author_name: 作者姓名
        user_fields: 字段映射 { "论文名称": "paper.title", ... }

    Returns:
        论文数据列表
    """
    request_body = {
        "author_name": author_name,
        "user_fields": user_fields,
    }
    body_bytes = json.dumps(request_body, ensure_ascii=False).encode("utf-8")

    req = urllib.request.Request(
        ACADEMIC_API_ENDPOINT,
        data=body_bytes,
        headers={
            "Content-Type": "application/json",
            "User-Agent": "ZAFS-Agent/1.0",
        },
        method="POST",
    )

    print(f"[fetch_academic] 调用远程API: {ACADEMIC_API_ENDPOINT}, author_name='{author_name}'")

    with urllib.request.urlopen(req, timeout=60) as resp:
        data = json.loads(resp.read().decode("utf-8"))

    # API 返回字段可能是 papers 或 results
    papers = data.get("papers") or data.get("results") or []
    print(f"[fetch_academic] 远程API返回 {len(papers)} 条论文数据")
    return papers


@tool
def fetch_academic_data(query: str = "", search_type: str = "author") -> str:
    """从远程学术成果 API（81.70.12.153:8060）获取论文数据。

    调用部署在服务器上的学术成果查询服务，数据来源涵盖 DBLP 和 CrossRef。

    Args:
        query: 作者姓名或论文标题关键词。
            例如："Wei Wang" 或 "Sheng Wang 0007"。
            **如果不填或填的是占位符（如 "Zhang San"、"张三"、"unknown"），
            将自动使用用户上下文中配置的真实作者姓名进行查询。**
        search_type: 搜索类型（当前版本统一按作者名查询，此参数保留兼容性）。
            - "author": 按作者名搜索其论文（默认）

    Returns:
        JSON 字符串，包含论文列表。每篇论文包含 title、year、venue、doi、authors 等字段。
    """
    global _academic_state_user_context

    # ── 1. 确定实际查询作者名 ──────────────────────────────
    # 优先使用 user_context（由前端传入，包含 DBLP PID 等完整信息）
    # 只有 user_context 为空时才使用 LLM 传入的 query
    placeholder_names = {"", "zhang san", "张三", "unknown", "none", "null", "author"}
    actual_query = (query or "").strip()
    if _academic_state_user_context:
        actual_query = _academic_state_user_context
        if (query or "").strip() and (query or "").strip() != _academic_state_user_context:
            print(f"[fetch_academic_data] user_context='{_academic_state_user_context}' 覆盖 LLM query='{query}'")
    elif actual_query.lower() in placeholder_names:
        return json.dumps({
            "success": False,
            "error": "未提供作者姓名，且 user_context 为空，无法查询",
            "papers": [],
        }, ensure_ascii=False)

    # ── 2. 解析实际使用的 user_fields（优先动态，fallback 默认）───
    actual_user_fields = _resolve_user_fields()

    # ── 3. 调用远程学术成果 API ────────────────────────────
    try:
        papers = _call_remote_academic_api(actual_query, actual_user_fields)
    except Exception as e:
        error_msg = str(e)
        print(f"[fetch_academic_data] 远程API调用失败: {error_msg}")
        return json.dumps({
            "success": False,
            "error": f"学术成果API调用失败: {error_msg}",
            "papers": [],
            "author": actual_query,
            "api_url": ACADEMIC_API_ENDPOINT,
        }, ensure_ascii=False)

    # ── 4. 处理结果 ─────────────────────────────────────────
    if not papers:
        return json.dumps({
            "success": False,
            "error": f"未从学术成果API找到 '{actual_query}' 的相关论文",
            "papers": [],
            "author": actual_query,
        }, ensure_ascii=False)

    return json.dumps({
        "success": True,
        "papers": papers,
        "total": len(papers),
        "author": actual_query,
        "source": "remote_api (DBLP+CrossRef)",
        "api_url": ACADEMIC_API_ENDPOINT,
        # ⚠️ 明确告诉 LLM 哪些字段有数据、哪些没有——防止编造
        "available_fields": list(DEFAULT_USER_FIELDS.keys()),
        "unavailable_fields": [
            "SSCI", "SCI", "EI", "影响因子", "Impact Factor", "IF",
            "期刊等级", "核心", "权威", "检索类型",
            "引用次数", "被引次数", "Citations", "H-index",
            "项目经费", "金额", "Amount",
            "姓名", "性别", "出生日期", "聘期",
            "这些字段在 API 返回数据中不存在，填表时必须留空",
        ],
    }, ensure_ascii=False)
