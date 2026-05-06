"""
Tool: fill_docx — 将 Markdown 表格数据填充到 DOCX 文档

复用 core/docx_utils.py 中的核心填充逻辑。

重要：docx_base64 不从 LLM 参数接收（LLM 会截断超长字符串），
而是从 Agent State 中读取原始文件数据。
"""

from langchain_core.tools import tool
import json
import base64
import zipfile
import xml.etree.ElementTree as ET
from io import BytesIO
from typing import List, Dict, Tuple

# 模块级变量：由 graph.py 在执行前注入当前 state 的 docx_base64
_state_docx_base64 = ""

# 学术 API 返回的论文总数（由 graph.py 从 state 注入，用于截断检测）
_academic_paper_total = 0

# 这些值代表"没找到数据"，应保持留白，而不是写进文档
_EMPTY_SENTINELS = {
    "暂无",
    "暂无数据",
    "暂未找到",
    "未找到",
    "未提供",
    "未知",
    "none",
    "null",
    "n/a",
    "na",
}

# ─── 数据填充原则 ──────────────────────────────────────────────
# 【核心原则】本地 KB 有的数据就填，本地没有的留空，API 返回的数据直接填。
# - KB 查询返回的数据 → 信任填写，不做二次校验
# - 学术 API 返回的论文数据 → 信任填写
# - 占位符空值（暂无/未知/N/A）→ 清空留空
# - 期刊等级字段（SSCI/SCI/EI/IF）→ 清空（API 不返回这些）
# - 明显的虚构内容（计划继续/预计等）→ 清空

# 1. SSCI/SCI/EI/核心/权威/影响因子：远程学术 API 不返回这些字段！
#    DEFAULT_USER_FIELDS 中完全没有期刊等级相关字段
#    因此这些列应该全部为空，除非未来 API 升级
_JOURNAL_RANKING_HEADERS = {
    "ssci", "sci", "ei", "影响因子", "impact factor", "if",
    "权威", "核心", "检索", "索引", "引用次数", "citations",
    "被引次数", "ssci、权威、核心 、/sci、ei及影响因子",  # 原始表头
    "ssci、权威、核心、/sci、ei及影响因子",  # 变体
}

# 2. 虚构项目/经历：典型的编造模式
_FABRICATION_INDICATORS = [
    "计划继续", "预计", "拟", "待定",  # 未来时间词
]


def set_allowed_names(names: list):
    """⚠️ 已弃用：姓名来源于 KB 查询，KB 返回的数据就是真实数据，不需要白名单。"""
    pass


def set_state_docx_base64(docx_base64: str):
    """在 Agent 执行前，将 state 中的 docx_base64 注入到此模块"""
    global _state_docx_base64
    _state_docx_base64 = docx_base64


def set_academic_paper_total(total: int):
    """注入学术 API 返回的论文总数，用于检测 LLM 输出截断"""
    global _academic_paper_total
    _academic_paper_total = total or 0


def _normalize_fill_value(value) -> Tuple[str, bool]:
    """将占位型空值统一转为空字符串。"""
    if value is None:
        return "", False
    text = value if isinstance(value, str) else str(value)
    stripped = text.strip()
    if stripped.lower() in _EMPTY_SENTINELS or stripped in _EMPTY_SENTINELS:
        return "", True
    return text, False


def _sanitize_md_tables(md_tables: List[Dict]) -> Tuple[List[Dict], int, int]:
    """清洗 Markdown 表格中的占位空值，并统计非空单元格数量。"""
    cleaned_tables: List[Dict] = []
    blanked_count = 0
    non_empty_cells = 0

    for table in md_tables:
        cleaned_rows = []
        for row in table.get("rows", []):
            cleaned_row = []
            for cell in row:
                cleaned_value, blanked = _normalize_fill_value(cell)
                if blanked:
                    blanked_count += 1
                if cleaned_value.strip():
                    non_empty_cells += 1
                cleaned_row.append(cleaned_value)
            cleaned_rows.append(cleaned_row)
        cleaned_tables.append({
            "headers": table.get("headers", []),
            "rows": cleaned_rows,
        })

    return cleaned_tables, blanked_count, non_empty_cells


def _log_md_table_summary(md_tables: List[Dict], blanked_count: int, non_empty_cells: int, raw_markdown: str):
    """输出最终待写入文档的数据摘要，便于排查来源。"""
    print(
        f"[fill_docx] Markdown摘要: tables={len(md_tables)}, non_empty_cells={non_empty_cells}, blanked_placeholders={blanked_count}"
    )
    preview = raw_markdown[:800].replace("\n", "\\n")
    print(f"[fill_docx] Markdown预览: {preview}")
    for idx, table in enumerate(md_tables, start=1):
        headers = table.get("headers", [])
        rows = table.get("rows", [])
        row_count = len(rows)
        filled_cells = sum(1 for row in rows for cell in row if str(cell).strip())
        # 输出前3行数据的摘要用于 debug
        row_preview = []
        for r in rows[:3]:
            row_preview.append([c[:30] if c else "" for c in r])
        print(f"[fill_docx] 表{idx}: headers={headers}, rows={row_count}, filled_cells={filled_cells}")
        if row_preview:
            print(f"[fill_docx]   前3行: {row_preview}")


def _header_matches_dangerous(header_str: str) -> bool:
    """
    判断表头是否属于需要硬校验的危险字段（SSCI/SCI/EI/IF/期刊等级等）。
    
    这些字段的值远程 API 从不返回，任何非空值几乎可以确定是 LLM 编造的。
    """
    h = header_str.strip().lower().replace(" ", "").replace("、", "/").replace("，", ",")
    # 精确匹配
    if h in _JOURNAL_RANKING_HEADERS:
        return True
    # 子串匹配：处理复合表头如 "SSCI、权威、核心 、/SCI、EI及影响因子"
    h_clean = header_str.strip().lower()
    for keyword in ["ssci", "sci", "ei", "影响因子", "权威", "核心"]:
        if keyword in h_clean:
            return True
    return False


def _is_fabricated_experience(value: str) -> bool:
    """检测虚构的未来经历/计划。"""
    v = value.strip().lower()
    return any(ind in v for ind in _FABRICATION_INDICATORS)


def _is_paper_table(table: dict) -> bool:
    """
    判断一个 Markdown 表格是否为论文表格。
    
    通过表头关键词判断：包含"论文"、"论文名称"、"publication"、"paper" 等关键词。
    """
    headers = table.get("headers", [])
    header_text = " ".join(headers).lower()
    paper_keywords = ["论文", "论文名称", "publication", "paper", "title",
                       "发表", "期刊", "journal", "作者"]
    return sum(1 for kw in paper_keywords if kw in header_text) >= 2


def _detect_paper_truncation(md_tables: list, expected_total: int) -> str:
    """
    检测论文表格是否被截断。
    
    规则：
    - 如果 API 返回了 N 条论文，但论文表格总行数 < N * 0.8（即缺失超过 20%），判定为截断
    - 对于 >10 条论文，允许 10% 的容错（论文表格中可能出现少量重复/无效行）
    """
    if expected_total <= 0:
        return ""
    
    # 找到所有论文表格，统计总行数
    paper_rows = 0
    for table in md_tables:
        if _is_paper_table(table):
            paper_rows += len(table.get("rows", []))
    
    if paper_rows == 0:
        return f"学术 API 返回了 {expected_total} 条论文，但 Markdown 中没有找到任何论文表格"
    
    # 缺失超过 20% 视为截断
    missing = expected_total - paper_rows
    if missing > expected_total * 0.2:
        return (
            f"论文可能被截断：学术 API 返回了 {expected_total} 条论文，"
            f"但 Markdown 论文表格只包含 {paper_rows} 行（缺失 {missing} 条）。"
            f"请确保所有论文都写入表格，不要截断。"
        )
    
    return ""


def _hard_validate_cell(header: str, value: str) -> Tuple[str, bool]:
    """
    对单个单元格做硬校验。

    【核心原则】KB/API 返回的数据就信任填写，只清空以下两类：
    1. 占位符空值（已在 _normalize_fill_value 处理）
    2. 明确的危险数据：期刊等级列（API从不返回）和虚构内容

    返回 (校验后值, 是否被清空)。
    """
    if value is None or (isinstance(value, str) and not value.strip()):
        return "", False

    text = str(value).strip()
    if not text:
        return "", False

    # 规则1: 期刊等级字段 → 强制清空（API 不返回这些数据）
    if _header_matches_dangerous(header):
        print(f"[hard_validate] 期刊等级字段清空: header='{header}', 原值='{text}'")
        return "", True

    # 规则2: 经历/说明中的虚构内容（未来时间词等）
    h = header.strip().lower()
    if any(kw in h for kw in ["说明", "备注", "描述", "description", "note"]):
        if _is_fabricated_experience(text):
            print(f"[hard_validate] 虚构内容清空: header='{header}', 值='{text}'")
            return "", True

    # KB/API 返回的数据全部信任填写，不做二次校验
    # 包括：姓名、出生日期、性别、金额、项目信息等
    return text, False


def _apply_hard_validation(md_tables: List[Dict]) -> Tuple[List[Dict], int]:
    """
   对所有表格应用硬校验规则。
    
    这是反幻觉的最后一道防线——不管 LLM 传了什么，
    已知危险字段中的编造数据都会在这里被清除。
    """
    validated_tables = []
    total_cleared = 0
    
    for table in md_tables:
        headers = table.get("headers", [])
        validated_rows = []
        for row in table.get("rows", []):
            validated_row = []
            for col_idx, cell in enumerate(row):
                col_header = headers[col_idx] if col_idx < len(headers) else f"列{col_idx+1}"
                cleaned, cleared = _hard_validate_cell(col_header, cell)
                if cleared:
                    total_cleared += 1
                validated_row.append(cleaned)
            validated_rows.append(validated_row)
        validated_tables.append({
            "headers": headers,
            "rows": validated_rows,
        })
    
    if total_cleared > 0:
        print(f"[hard_validate] 总共清除了 {total_cleared} 个编造单元格")
    
    return validated_tables, total_cleared


@tool
def fill_docx(tables_markdown: str, mapping_info: str = "", target_tables: str = "all") -> str:
    """将 Markdown 格式的表格数据填充到原始 Word 文档中。

    **这是填表流程的最后一步（阶段三）**。在调用此工具之前，
    你应该已经完成了：
    - 阶段一：数据采集（parse_docx + fetch_academic + query_kb + rag）
    - 阶段二：整理标准 Markdown 结构 + 分析映射关系 + 输出表头清单

    注意：此工具会自动使用用户上传的原始 DOCX 文件进行填充，
    不需要你传入 docx_base64 参数。只需传入整理好的 Markdown 表格即可。

    ⚠️ **截断检测**：此工具会检查论文表格的行数是否与学术 API 返回的论文总数一致。
    如果你的输出被 max_tokens 截断导致论文数量不足，此工具会返回错误。
    此时你需要重新调用此工具，确保论文表格包含所有论文。

    ⚠️ **分批填充（更可靠）**：如果论文数量很多（>20条），推荐使用分批填充：
    - 第一次调用：`target_tables="papers"`，只填论文表格
    - 第二次调用：`target_tables="others"`，填其他表格（个人信息、教学、项目等）
    这样可以避免单次输出过长被截断。

    Args:
        tables_markdown: Markdown 格式的表格数据（**所有表格的完整数据**）。
            支持多个表格（用空行分隔）。

            ⚠️ 核心格式要求：

            **格式 A — 有表头的普通表格**（Markdown 列名 = Word 表格列名）：
            | 论文名称 | 发表时间 | 期刊/会议 | 作者 | SSCI/SCI/EI |
            |---------|---------|-----------|------|------------|
            | Paper A  | 2025    | IEEE      | ...  |            |

            **格式 B — 无表头的空表格**（叙述性区域）：
            | 表格标题   | 填充内容                                              |
            |-----------|-----------------------------------------------------|
            | 教学情况   | 从 CV/RAG 提取的教学经历文本...                      |

        mapping_info: （可选但推荐）映射关系说明文本。
            描述每个 Markdown 表格对应原文档哪个表格。
            格式示例：
            "MD表格1(论文)→Word表格#1; MD表格2(个人信息)→Word表格#2; MD表格3(教学)→Word空表格#3"

            此信息会被记录到日志中用于调试，不影响实际填充逻辑。

        target_tables: 指定要填充哪些类型的表格。可选值：
            - "all"（默认）：填充所有表格
            - "papers"：只填充论文表格（跳过个人信息、教学、项目等其他表格）
            - "others"：只填充非论文表格（论文表格保持原样）
            
            **分批填充示例**：
            第一次调用：fill_docx(论文表格的markdown, target_tables="papers")
            第二次调用：fill_docx(其他表格的markdown, target_tables="others")
            两次调用都会在之前的填充结果基础上继续填充，不会覆盖已有数据。

    Returns:
        JSON 字符串，包含：
        - success: 是否成功
        - docx_base64: 填充后的 DOCX 文件（Base64）
        - filled_count: 成功填充的表格数量
        - mapping_summary: 映射关系摘要（每个匹配的 Word↔Markdown 对）
        - word_headers_summary: 原文档所有待填表格的表头/标题清单
        - message: 执行结果描述
        - target_tables: 本次填充使用的模式
    """
    try:
        from core import parse_markdown_tables, fill_xml_tables_all, repair_zip

        # 从 state（模块级变量）获取 docx_base64，而不是从 LLM 参数
        docx_base64 = _state_docx_base64
        print(f"[fill_docx] docx_base64 长度: {len(docx_base64)}, 前50字符: {docx_base64[:50]}...")
        if not docx_base64:
            return json.dumps({
                "success": False,
                "error": "DOCX 数据未初始化（state 中缺少 docx_base64）",
            }, ensure_ascii=False)

        # 解码 DOCX
        content = base64.b64decode(docx_base64)

        # ZIP 修复检查
        try:
            test_zip = BytesIO(content)
            with zipfile.ZipFile(test_zip, 'r') as z:
                pass
        except zipfile.BadZipFile:
            repaired = repair_zip(content)
            if repaired is not None:
                content = repaired
            else:
                return json.dumps({
                    "success": False,
                    "error": "DOCX 文件损坏且无法修复",
                }, ensure_ascii=False)

        # 解析 Markdown 表格
        md_tables, _ = parse_markdown_tables(tables_markdown)
        if not md_tables:
            return json.dumps({
                "success": False,
                "error": "Markdown 表格解析结果为空",
                "filled_count": 0,
                "word_headers_summary": [],
                "mapping_summary": "",
            }, ensure_ascii=False)

        # ── 分批填充过滤 ──
        # 根据 target_tables 参数过滤要填充的表格类型
        original_table_count = len(md_tables)
        if target_tables == "papers":
            # 只保留论文表格
            md_tables = [t for t in md_tables if _is_paper_table(t)]
            print(f"[fill_docx] target_tables=papers: 从 {original_table_count} 个表格中过滤出 {len(md_tables)} 个论文表格")
        elif target_tables == "others":
            # 只保留非论文表格（个人信息、教学、项目等）
            md_tables = [t for t in md_tables if not _is_paper_table(t)]
            print(f"[fill_docx] target_tables=others: 从 {original_table_count} 个表格中过滤出 {len(md_tables)} 个非论文表格")
        else:
            print(f"[fill_docx] target_tables=all: 填充全部 {len(md_tables)} 个表格")

        if not md_tables:
            return json.dumps({
                "success": False,
                "error": f"target_tables={target_tables} 模式下没有找到可填充的表格",
                "filled_count": 0,
                "word_headers_summary": [],
                "mapping_summary": "",
                "target_tables": target_tables,
            }, ensure_ascii=False)

        # 清洗占位空值：对于找不到数据的字段保持留白，不写入"暂无/未知/N/A"等占位词
        md_tables, blanked_count, non_empty_cells = _sanitize_md_tables(md_tables)
        
        # ── 硬校验层：反幻觉最后一道防线 ──
        # 对 SSCI/SCI/EI/IF/姓名/出生日期/金额等危险字段强制校验
        # 不管 LLM 传了什么，编造的数据在这里都会被清除
        md_tables, hard_cleared = _apply_hard_validation(md_tables)
        if hard_cleared > 0:
            non_empty_cells = sum(
                1 for t in md_tables 
                for row in t.get("rows", []) 
                for cell in row if str(cell).strip()
            )
        
        # ── 论文截断检测 ──
        # 如果学术 API 返回了 N 条论文，但 LLM 在 Markdown 论文表格中只写了 M << N 条，
        # 说明 LLM 输出被 max_tokens 截断了，需要报错让 LLM 重新生成。
        #
        # ⚠️ 重要：截断检测在 "all" 和 "papers" 两种分批模式下都要生效。
        # - "all" 模式：所有表格混在一起，截断时论文和其他表格都受影响
        # - "papers" 模式：只有论文表格，此时截断检测尤为关键
        # - "others" 模式：不包含论文表格，不需要检测
        global _academic_paper_total
        if _academic_paper_total > 0 and target_tables in ("all", "papers"):
            paper_truncation_warning = _detect_paper_truncation(md_tables, _academic_paper_total)
            if paper_truncation_warning:
                print(f"[fill_docx] ⚠️ {paper_truncation_warning}")
                return json.dumps({
                    "success": False,
                    "error": paper_truncation_warning,
                    "total_papers_expected": _academic_paper_total,
                    "total_papers_in_markdown": sum(
                        len(t.get("rows", []))
                        for t in md_tables
                        if _is_paper_table(t)
                    ),
                    "hint": (
                        "你的输出被 max_tokens 截断了！论文数量不足。"
                        "请重新调用 fill_docx，确保：\n"
                        "1. 只传论文表格（一行一条，写完全部 {0} 条论文）\n"
                        "2. 不要传其他表格（个人信息/教学/项目等），先确保论文写完\n"
                        "3. 使用 target_tables='papers'（只填论文）\n"
                        "4. 绝对不要在论文中间写'...'或'省略N条'——必须逐行写出完整 {0} 条"
                    ).format(_academic_paper_total),
                }, ensure_ascii=False)
        
        _log_md_table_summary(md_tables, blanked_count + hard_cleared, non_empty_cells, tables_markdown)

        # ── 提取原文档表格信息（用于输出表头清单和映射摘要）──
        word_headers_summary = _extract_word_table_headers(content)
        mapping_summary = _build_mapping_summary(word_headers_summary, md_tables, mapping_info)

        print(f"[fill_docx] === 映射摘要 ===")
        print(f"[fill_docx] {mapping_summary}")
        print(f"[fill_docx] === Word 表格清单 ===")
        for idx, info in enumerate(word_headers_summary):
            print(f"[fill_docx]   [{idx}] {info}")

        # 读取并修改 document.xml
        input_zip = BytesIO(content)
        output_zip = BytesIO()

        with zipfile.ZipFile(input_zip, 'r') as z_in:
            with zipfile.ZipFile(output_zip, 'w', zipfile.ZIP_DEFLATED) as z_out:
                for item in z_in.infolist():
                    data = z_in.read(item.filename)
                    if item.filename == 'word/document.xml':
                        xml_content = data.decode('utf-8')
                        xml_content = fill_xml_tables_all(xml_content, md_tables)
                        data = xml_content.encode('utf-8')
                    z_out.writestr(item, data)

        output_zip.seek(0)
        result_base64 = base64.b64encode(output_zip.getvalue()).decode('utf-8')

        return json.dumps({
            "success": True,
            "docx_base64": result_base64,
            "filled_count": len(md_tables),
            "message": f"成功填充 {len(md_tables)} 个表格（模式: {target_tables}）",
            "mapping_summary": mapping_summary,
            "word_headers_summary": word_headers_summary,
            "md_tables_info": [
                {"headers": t.get("headers", []), "row_count": len(t.get("rows", []))}
                for t in md_tables
            ],
            "target_tables": target_tables,
        }, ensure_ascii=False)

    except Exception as e:
        import traceback
        return json.dumps({
            "success": False,
            "error": str(e),
            "traceback": traceback.format_exc(),
        }, ensure_ascii=False)


# ─── 新增：Word 表格信息提取和映射摘要生成 ─────────────

def _extract_word_table_headers(docx_bytes: bytes) -> list:
    """
    从 DOCX 二进制数据中提取所有表格的表头/标题信息。
    
    返回一个列表，每个元素是一个字典描述一个 Word 表格：
    - 有表头的普通表格: {"index": 0, "type": "headered", "headers": [...], "title": ""}
    - 无表头的空表格:     {"index": 2, "type": "empty",   "headers": [], "title": "教学情况"}
    
    这个输出就是「待填表格的所有表头（没表头的输出标题）」的具体实现。
    """
    try:
        from core import _get_table_headers_from_xml, _get_table_title_before

        input_zip = BytesIO(docx_bytes)
        with zipfile.ZipFile(input_zip, 'r') as z:
            xml_content = z.read('word/document.xml')
        root = ET.fromstring(xml_content)
        ns = {'w': 'http://schemas.openxmlformats.org/wordprocessingml/2006/main'}
        
        tables = root.findall('.//w:tbl', ns)
        result = []
        
        for table_idx, table in enumerate(tables):
            headers = _get_table_headers_from_xml(table)
            non_empty_headers = [h for h in headers if h.strip()]
            
            if non_empty_headers:
                # 有表头的普通表格
                result.append({
                    "index": table_idx,
                    "type": "headered",
                    "headers": headers,
                    "title": "",
                })
            else:
                # 无表头的空表格 → 提取前面的段落标题
                title = _get_table_title_before(table, root)
                result.append({
                    "index": table_idx,
                    "type": "empty",
                    "headers": [],
                    "title": title,
                })
        
        return result
    
    except Exception as e:
        print(f"[fill_docx] _extract_word_table_headers 出错: {e}")
        return []


def _build_mapping_summary(word_headers: list, md_tables: list, mapping_info: str = "") -> str:
    """
    构建映射关系摘要字符串，描述每个 Markdown 表格映射到了哪个 Word 表格。
    
    结合 fill_xml_tables_all 的实际匹配结果，给出清晰的对照说明。
    """
    lines = ["=== 填写映射摘要 ==="]
    
    for md_idx, md_table in enumerate(md_tables):
        md_headers = md_table.get("headers", [])
        row_count = len(md_table.get("rows", []))
        
        # 判断是否为"表格标题/填充内容"格式的空表格
        is_empty_table_format = (
            len(md_headers) == 2 and
            "表格标题" in "".join(md_headers) and
            "填充内容" in "".join(md_headers)
        )
        
        if is_empty_table_format and md_table.get("rows"):
            # 空表格格式：从第一列提取标题
            titles = [row[0] for row in md_table.get("rows", []) if row and row[0].strip()]
            lines.append(
                f"  MD#{md_idx} (空表格格式, {len(titles)} 个区域): "
                f"标题 → {titles}"
            )
        else:
            # 普通有表头表格
            lines.append(
                f"  MD#{md_idx} (有表头, {row_count} 行): "
                f"列 → {md_headers}"
            )
    
    # 原文档表格清单
    lines.append("\n--- 原文档待填表格 ---")
    for winfo in word_headers:
        idx = winfo.get("index", "?")
        if winfo.get("type") == "headered":
            lines.append(f"  Word#{idx}: 表头 = {winfo.get('headers', [])}")
        else:
            lines.append(f"  Word#{idx}: 空表格(无表头), 标题 = '{winfo.get('title', '')}'")
    
    # LLM 提供的映射说明（如果有）
    if mapping_info and mapping_info.strip():
        lines.append(f"\n--- LLM 映射说明 ---\n{mapping_info}")
    
    return "\n".join(lines)
