"""
Tool: parse_docx — 解析 DOCX 文档，提取表格结构和空字段

Agent 调用此工具来分析待填写的 Word 文档。
docx_base64 从 Agent State 注入（不通过 LLM 参数传递）。
"""

from langchain_core.tools import tool
import base64
import xml.etree.ElementTree as ET
import zipfile
from io import BytesIO
from typing import Dict, List, Any

# 模块级变量：由 graph.py 在执行前注入当前 state 的 docx_base64
_state_docx_base64 = ""


def set_parse_state_docx(docx_base64: str):
    """在 Agent 执行前，将 state 中的 docx_base64 注入到此模块"""
    global _state_docx_base64
    _state_docx_base64 = docx_base64


@tool
def parse_docx() -> str:
    """解析用户上传的 DOCX 文档，提取所有表格结构和空字段信息。

    此工具会自动使用用户上传的原始 Word 文档，不需要你传入任何参数。
    直接调用即可获取文档结构信息（表格列表、表头、空字段等）。

    Returns:
        JSON 字符串，包含：
        - success: 是否成功
        - doc_text: 文档全文
        - tables: 表格信息列表（含 headers, empty_columns, data_rows, context）
        - table_count: 表格总数
        - empty_fields: 需要填写的空字段名列表
        - empty_field_count: 空字段数量
    """
    try:
        # 从 state 获取 docx_base64
        docx_base64 = _state_docx_base64
        print(f"[parse_docx] docx_base64 长度: {len(docx_base64)}")

        if not docx_base64:
            return _json_result(False, error="DOCX 数据未初始化（state 中缺少 docx_base64）")

        content = base64.b64decode(docx_base64)
        input_zip = BytesIO(content)

        tables_info: List[Dict[str, Any]] = []
        full_text: List[str] = []

        with zipfile.ZipFile(input_zip, 'r') as z_in:
            if 'word/document.xml' not in z_in.namelist():
                return _json_result(False, error="无效的 DOCX：缺少 document.xml")

            doc_xml = z_in.read('word/document.xml').decode('utf-8')
            root = ET.fromstring(doc_xml)

            ns = {'w': 'http://schemas.openxmlformats.org/wordprocessingml/2006/main'}

            # ── 遍历 body 子元素，按顺序提取段落和表格 ──
            # 这样能记录每个表格前面的段落标题（context）
            table_contexts: Dict[int, str] = {}  # table_index -> 最近的段落标题
            recent_headings: List[str] = []  # 滑动窗口，保留最近3个标题

            body = root.find('.//w:body', ns)

            if body is None:
                # fallback: 用旧方式遍历
                for para in root.findall('.//w:p', ns):
                    texts = para.findall('.//w:t', ns)
                    para_text = ''.join(t.text or '' for t in texts)
                    if para_text.strip():
                        full_text.append(para_text)

                # 旧方式提取表格
                for table_idx, table in enumerate(root.findall('.//w:tbl', ns)):
                    _extract_table(table, ns, table_idx, "", tables_info)
            else:
                table_idx = 0
                for child in body:
                    tag = child.tag.split('}')[-1] if '}' in child.tag else child.tag

                    if tag == 'p':
                        texts = child.findall('.//w:t', ns)
                        para_text = ''.join(t.text or '' for t in texts).strip()
                        if para_text:
                            full_text.append(para_text)
                            # 判断是否像标题（短文本 + 特定前缀模式）
                            if _is_heading_like(para_text):
                                recent_headings.append(para_text)
                                if len(recent_headings) > 3:
                                    recent_headings.pop(0)

                    elif tag == 'tbl':
                        # 记录当前表格的段落上下文
                        ctx = ' | '.join(recent_headings) if recent_headings else ""
                        table_contexts[table_idx] = ctx
                        _extract_table(child, ns, table_idx, ctx, tables_info)
                        table_idx += 1

        # 收集空字段名
        empty_fields = []
        for table in tables_info:
            for col_idx in table["empty_columns"]:
                if col_idx < len(table["headers"]):
                    field_name = table["headers"][col_idx]
                    if field_name and field_name not in empty_fields:
                        empty_fields.append(field_name)

        # 同时检查已有表头但无数据行的表格（空表格）
        for table in tables_info:
            if table["total_rows"] == 0 and table["headers"]:
                for h in table["headers"]:
                    if h and h not in empty_fields:
                        empty_fields.append(h)

        # ── 结构化调试日志：输出每个表格的完整信息 ──
        print(f"[parse_docx] ===== 文档表格结构概览 =====")
        for table in tables_info:
            headers_str = f"表头=[{', '.join(h for h in table['headers'])}]"
            ctx_str = f"标题={table['context']}" if table.get("context") else "标题=(无)"
            empty_str = f"空列索引={table['empty_columns']}" if table["empty_columns"] else "无空列"
            empty_table_str = " [空表格]" if table.get("is_empty_table") else ""
            data_rows_str = f"已有数据行数={table['total_rows']}"
            print(f"[parse_docx]   表格#{table['index']}: {ctx_str} | {headers_str} | {empty_str} | {data_rows_str}{empty_table_str}")
        print(f"[parse_docx] ===== 共 {len(tables_info)} 个表格, {len(empty_fields)} 个空字段 =====")

        import json
        result = json.dumps({
            "success": True,
            "doc_text": "\n".join(full_text),
            "tables": tables_info,
            "table_count": len(tables_info),
            "empty_fields": empty_fields,
            "empty_field_count": len(empty_fields),
        }, ensure_ascii=False)
        print(f"[parse_docx] 解析成功: {len(tables_info)} 个表格, {len(empty_fields)} 个空字段")
        return result

    except Exception as e:
        print(f"[parse_docx] 错误: {e}")
        import traceback
        traceback.print_exc()
        return _json_result(False, error=str(e))


def _is_heading_like(text: str) -> bool:
    """判断段落文本是否像标题"""
    if len(text) > 80:
        return False
    # 中文编号标题
    if text.startswith(('一、', '二、', '三、', '四、', '五、', '六、', '七、', '八、', '九、', '十、',
                        '1、', '2、', '3、', '4、', '5、', '6、', '（', '(')):
        return True
    # 短文本且不含句末标点
    if len(text) < 40 and not any(c in text for c in '。，；！？'):
        return True
    return False


def _extract_table(table_elem, ns: dict, table_idx: int, context: str,
                   tables_info: List[Dict[str, Any]]):
    """从一个 w:tbl 元素中提取表格信息并追加到 tables_info"""
    trs = table_elem.findall('.//w:tr', ns)
    if not trs:
        return

    # 表头
    header_cells = trs[0].findall('.//w:tc', ns)
    headers = []
    empty_columns = []
    for cell_idx, cell in enumerate(header_cells):
        texts = cell.findall('.//w:t', ns)
        cell_text = ''.join(t.text or '' for t in texts).strip()
        headers.append(cell_text if cell_text else f"列{cell_idx + 1}")
        if not cell_text:
            empty_columns.append(cell_idx)

    # 数据行（最多 50 行）
    data_rows = []
    for row in trs[1:51]:
        cells = row.findall('.//w:tc', ns)
        row_data = [''.join(t.text or '' for t in c.findall('.//w:t', ns)).strip()
                    for c in cells]
        if any(c.strip() for c in row_data):
            data_rows.append(row_data)

    tables_info.append({
        "index": table_idx,
        "headers": headers,
        "empty_columns": empty_columns,
        "data_rows": data_rows,
        "total_rows": len(trs) - 1,
        "context": context,
        "table_title": context.split(" | ")[-1] if context else "",  # 取最近的一个标题作为主标题
        "is_empty_table": len(headers) > 0 and all(
            not h.strip() or h.startswith("列") for h in headers
        ) and len(data_rows) == 0,
    })


def _json_result(success: bool, **kwargs) -> str:
    import json
    result = {"success": success}
    result.update(kwargs)
    return json.dumps(result, ensure_ascii=False)
