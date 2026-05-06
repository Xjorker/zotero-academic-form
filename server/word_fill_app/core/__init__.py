"""
docx_utils.py — DOCX 解析和填充的核心函数

从 main.py 中提取出来，避免循环导入。
被 main.py（旧端点）和 agent/tools/fill_docx.py（Agent 工具）共同使用。
"""

import zipfile
import xml.etree.ElementTree as ET
from io import BytesIO
from typing import Dict, List, Any, Tuple, Optional
import re


# ─── ZIP 修复 ──────────────────────────────────────────────

def repair_zip(corrupted_data: bytes) -> Optional[bytes]:
    """
    尝试修复损坏的 ZIP 文件
    通过扫描本地文件头（PK\\x03\\x04）重建 ZIP
    """
    import struct

    files_found = []
    pos = 0

    while pos < len(corrupted_data) - 4:
        if corrupted_data[pos:pos+4] == b'PK\x03\x04':
            try:
                header_end = pos + 30
                if header_end > len(corrupted_data):
                    break

                (sig, version, flags, compression, mod_time, mod_date,
                 crc32, compressed_size, uncompressed_size,
                 filename_len, extra_len) = struct.unpack('<4sHHHHHIIIHH', corrupted_data[pos:header_end])

                filename_start = header_end
                filename_end = filename_start + filename_len
                extra_end = filename_end + extra_len
                data_start = extra_end
                data_end = data_start + compressed_size

                if filename_len == 0 or filename_len > 1000:
                    pos += 4
                    continue

                if data_end > len(corrupted_data):
                    pos += 4
                    continue

                filename = corrupted_data[filename_start:filename_end].decode('utf-8', errors='ignore')
                data = corrupted_data[data_start:data_end]

                if not filename.endswith('/'):
                    files_found.append({
                        'name': filename,
                        'data': data,
                        'compression': compression,
                    })

                pos = data_end
            except Exception:
                pos += 4
                continue
        else:
            pos += 1

    if not files_found:
        return None

    output = BytesIO()
    with zipfile.ZipFile(output, 'w', zipfile.ZIP_DEFLATED) as zf:
        for file_info in files_found:
            try:
                zf.writestr(file_info['name'], file_info['data'])
            except Exception:
                continue

    return output.getvalue()


# ─── Markdown 表格解析 ─────────────────────────────────────

def _parse_table_block(lines: List[str]) -> Optional[dict]:
    """解析单个表格块的行列表，返回 {"headers": [...], "rows": [...]} 或 None"""
    headers = []
    rows = []
    is_header = True
    # 先确定最大列数（用分隔行），用于保留空单元格
    max_cols = 0
    for line in lines:
        if re.match(r'^\|[\s\-:|]+\|$', line):
            # 分隔行：| --- | --- | → 数管道符数量
            max_cols = max(max_cols, len([x for x in line.split('|') if True]) - 2)

    for line in lines:
        line = line.strip()
        if not line or not line.startswith('|'):
            continue
        if re.match(r'^\|[\s\-:|]+\|$', line):
            is_header = False
            continue
        cells = [cell.strip() for cell in line.split('|')[1:-1]]
        # 不再过滤空单元格！保留原始列数以对齐 Word 表格
        if is_header:
            headers = cells
            is_header = False
        else:
            rows.append(cells)
    if headers or rows:
        return {"headers": headers, "rows": rows}
    return None


def _extract_tables_from_markdown(markdown: str) -> List[dict]:
    """从 markdown 中提取表格（内部函数）

    重要修复：保留空单元格不过滤，确保 Markdown 表格列数与 Word 表格对齐。
    """
    if '\n' not in markdown:
        separator_count = len(re.findall(r'\|\s*[-:]+\s*\|', markdown))
        if separator_count >= 2:
            marked = re.sub(r'(\|\s*[-:]+\s*\|)\s*(\|\s*[-:]+\s*\|)', r'\n---\n\2', markdown)
            marked = re.sub(r'(\|\s*[-:]+\s*\|)', r'\n---\n', marked)
            marked = re.sub(r'\|\s*\|\s*', '\n', marked)
            blocks = marked.split(r'\n---\n')
            tables = []
            for block in blocks:
                block = block.strip()
                if not block:
                    continue
                table = _parse_table_block(block.split('\n'))
                if table:
                    tables.append(table)
            if tables:
                return tables

    table_blocks = re.split(r'\n\s*\n', markdown)
    tables = []
    for block in table_blocks:
        block = block.strip()
        if not block:
            continue
        table = _parse_table_block(block.split('\n'))
        if table:
            tables.append(table)
    return tables


def parse_markdown_tables(markdown: str) -> Tuple[List[dict], dict]:
    """解析 markdown 中的所有表格"""
    markdown = markdown.strip()
    tables = _extract_tables_from_markdown(markdown)
    return tables, {}


# ─── XML 表格填充 ──────────────────────────────────────────

def _normalize_simple(text: str) -> str:
    """规范化表头文本"""
    text = ''.join(c for c in text if not c.isspace())
    text = text.lower()
    text = re.sub(r'[^\w\u4e00-\u9fff]+', '', text)
    return text


def _get_cell_text(cell) -> str:
    """获取表格单元格的全部文本（合并多个 w:t 元素）"""
    ns = {'w': 'http://schemas.openxmlformats.org/wordprocessingml/2006/main'}
    texts = cell.findall('.//w:t', ns)
    return ''.join(t.text or '' for t in texts).strip()


def _get_table_headers_from_xml(table) -> List[str]:
    """从 XML 表格中提取表头（支持单元格内多个 w:t 元素合并）"""
    ns = {'w': 'http://schemas.openxmlformats.org/wordprocessingml/2006/main'}
    trs = table.findall('.//w:tr', ns)
    if not trs:
        return []
    headers = []
    for tc in trs[0].findall('.//w:tc', ns):
        text = _get_cell_text(tc)
        headers.append(text)
    return headers


def _calculate_match_score(doc_headers: List[str], md_headers: List[str]) -> float:
    """计算表格匹配分数

    改进：采用比例评分制，不再要求全部列名都匹配才给分。
    匹配比例 ≥ 50% 即可返回非零分数，匹配比例越高分数越高。
    """
    if not doc_headers or not md_headers:
        return 0

    # 过滤掉空表头（Word 中合并单元格会产生空表头）
    doc_normalized = [_normalize_simple(h) for h in doc_headers if h.strip()]
    md_normalized = [_normalize_simple(h) for h in md_headers if h.strip()]

    if not doc_normalized or not md_normalized:
        return 0

    # 列数维度：列数越接近，加分越多
    size_score = 0
    if len(doc_normalized) == len(md_normalized):
        size_score = 10
    elif abs(len(doc_normalized) - len(md_normalized) <= 1):
        size_score = 5
    elif abs(len(doc_normalized) - len(md_normalized) <= 2):
        size_score = 2

    # 列名匹配：每个 md_header 找最佳 doc_header
    matched_count = 0
    used_doc_indices = set()  # 防止多个 md_header 匹配同一个 doc_header
    for md_h in md_normalized:
        best_doc_idx = -1
        best_doc_len = 0
        for doc_idx, doc_h in enumerate(doc_normalized):
            if doc_idx in used_doc_indices:
                continue
            # 完全匹配
            if doc_h == md_h:
                best_doc_idx = doc_idx
                best_doc_len = len(doc_h)
                break
            # 子串匹配（任一方包含另一方）
            if len(doc_h) >= 2 and len(md_h) >= 2:
                if doc_h in md_h or md_h in doc_h:
                    # 优先选择更精确的匹配（长度更接近的）
                    match_len = min(len(doc_h), len(md_h))
                    if best_doc_idx == -1 or match_len > best_doc_len:
                        best_doc_idx = doc_idx
                        best_doc_len = match_len
        if best_doc_idx >= 0:
            matched_count += 1
            used_doc_indices.add(best_doc_idx)

    # 比例评分：匹配比例 × 基础分
    match_ratio = matched_count / len(md_normalized) if md_normalized else 0
    if match_ratio < 0.5:
        return 0  # 低于 50% 匹配，不认为是对应表格

    # 分数 = 尺寸分 + 匹配分（0~90）
    # 100% 匹配 + 列数相同 = 10 + 90 = 100
    # 50% 匹配 + 列数差2 = 2 + 45 = 47
    match_score = match_ratio * 90
    total_score = size_score + match_score

    # 四舍五入到整数
    return round(total_score)


def _clear_cell_text(cell_element):
    """清空单元格中的所有文本内容（保留格式结构）"""
    ns = {'w': 'http://schemas.openxmlformats.org/wordprocessingml/2006/main'}
    for t in cell_element.findall('.//w:t', ns):
        t.text = ''


def _deep_copy_element(element):
    """递归深复制 XML 元素，保留原始命名空间前缀（tag 名字不变）。

    python 的 copy.deepcopy 会把 w:tag 改为 ns0:tag，导致 Word 无法识别。
    此函数手动递归复制所有子元素和属性，保持 tag 名字不变。
    """
    new_elem = ET.Element(element.tag, element.attrib)
    for child in element:
        new_child = _deep_copy_element(child)
        new_elem.append(new_child)
    # 复制 tail（元素后面的文本）
    if element.text:
        new_elem.text = element.text
    if element.tail:
        new_elem.tail = element.tail
    return new_elem


def _fill_table_cell(cell_element, value: str):
    """填充表格单元格

    先清空所有文本（防止 deepcopy 表头行残留文字），
    再将值写入第一个 w:t 元素。
    """
    ns = {'w': 'http://schemas.openxmlformats.org/wordprocessingml/2006/main'}
    _clear_cell_text(cell_element)
    text_elem = cell_element.find('.//w:t', ns)
    if text_elem is not None:
        text_elem.text = value
    else:
        p = cell_element.find('.//w:p', ns)
        if p is None:
            p = ET.SubElement(cell_element, '{http://schemas.openxmlformats.org/wordprocessingml/2006/main}p')
        r = ET.SubElement(p, '{http://schemas.openxmlformats.org/wordprocessingml/2006/main}r')
        text_elem = ET.SubElement(r, '{http://schemas.openxmlformats.org/wordprocessingml/2006/main}t')
        text_elem.text = value
        text_elem.set('{http://www.w3.org/XML/1998/namespace}space', 'preserve')


def _get_table_title_before(table, root) -> str:
    """获取表格前面的标题文本（向上查找多个段落）"""
    ns = {'w': 'http://schemas.openxmlformats.org/wordprocessingml/2006/main'}
    body = root.find('.//w:body', ns)
    if body is None:
        return ""
    elements = list(body)
    table_idx = -1
    for i, elem in enumerate(elements):
        if elem is table:
            table_idx = i
            break
    if table_idx <= 0:
        return ""

    # 向上查找，收集最近的段落标题（最多 3 段）
    title_parts = []
    for i in range(table_idx - 1, max(table_idx - 5, -1), -1):
        elem = elements[i]
        if elem.tag == '{http://schemas.openxmlformats.org/wordprocessingml/2006/main}tbl':
            break
        if elem.tag == '{http://schemas.openxmlformats.org/wordprocessingml/2006/main}p':
            texts = elem.findall('.//w:t', ns)
            if texts:
                para_text = ''.join([t.text or '' for t in texts]).strip()
                if para_text and len(para_text) < 200:
                    title_parts.insert(0, para_text)
    return ' '.join(title_parts) if title_parts else ""


def _fill_empty_table_by_title(table, title: str, content: str, namespaces):
    """根据标题填充空表格（叙述性内容区域）"""
    ns = namespaces
    trs = table.findall('.//w:tr', ns)
    if not trs:
        return False
    doc_headers = _get_table_headers_from_xml(table)
    is_empty_table = len(trs) <= 1 or not any(h.strip() for h in doc_headers)
    if not is_empty_table:
        return False
    header_tr = trs[0]
    tcs = header_tr.findall('.//w:tc', ns)
    if tcs:
        _fill_table_cell(tcs[0], content)
        return True
    return False


def _text_match_score(a: str, b: str) -> float:
    """计算两个规范化文本的匹配度分数（0~100）"""
    if not a or not b:
        return 0
    a_norm = _normalize_simple(a)
    b_norm = _normalize_simple(b)
    if a_norm == b_norm:
        return 100
    if len(a_norm) >= 2 and len(b_norm) >= 2:
        if a_norm in b_norm:
            return 60 + min(40, len(a_norm) * 3)  # 子串匹配，越长分越高
        if b_norm in a_norm:
            return 60 + min(40, len(b_norm) * 3)
    return 0


def _try_match_empty_table(table, root, ns, md_tables, matched_empty_rows) -> bool:
    """尝试为空表格匹配 Markdown 数据

    支持两种 Markdown 格式：
    1. 标准格式：| 表格标题 | 填充内容 |（旧格式，保持兼容）
    2. 普通格式：任意表头 + 行数据（新格式，通过标题前文匹配）

    Returns:
        True 如果成功匹配并填充
    """
    table_title = _get_table_title_before(table, root)
    if not table_title:
        return False

    for md_idx, md_table in enumerate(md_tables):
        md_headers = md_table.get("headers", [])
        md_rows = md_table.get("rows", [])

        # 方式1：标准空表格格式 | 表格标题 | 填充内容 |
        if len(md_headers) == 2:
            header_norm = [_normalize_simple(h) for h in md_headers]
            if "表格标题" in header_norm[0] and "填充内容" in header_norm[1]:
                for row_idx, md_row in enumerate(md_rows):
                    if len(md_row) >= 2 and (md_idx, row_idx) not in matched_empty_rows:
                        md_title = md_row[0]
                        md_content = md_row[1]
                        score = _text_match_score(table_title, md_title)
                        if score >= 40:  # 标题匹配即可填充
                            if _fill_empty_table_by_title(table, table_title, md_content, ns):
                                matched_empty_rows.add((md_idx, row_idx))
                                return True
                continue  # 即使方式1没匹配上，也不试方式2（因为格式不兼容）

        # 方式2：通过行数据的第一个单元格匹配标题
        # 对于 LLM 没用标准格式的叙述性表格
        if md_rows and not md_rows[0]:  # 跳过空行
            continue
        for row_idx, md_row in enumerate(md_rows):
            if md_row and (md_idx, row_idx) not in matched_empty_rows:
                # 用行数据的第一个非空单元格尝试匹配表格标题
                candidate = md_row[0] if md_row[0] else ""
                if candidate:
                    score = _text_match_score(table_title, candidate)
                    if score >= 50:
                        # 将剩余单元格拼接为内容
                        content = ' '.join(c for c in md_row[1:] if c.strip())
                        if not content and len(md_row) == 1:
                            content = candidate  # 只有一列时整行就是内容
                        if content and _fill_empty_table_by_title(table, table_title, content, ns):
                            matched_empty_rows.add((md_idx, row_idx))
                            return True

    return False


def fill_xml_tables_all(xml_content: str, md_tables: List[dict]) -> str:
    """用 markdown 表格数据填充 XML 中的所有表格

    改进策略：
    1. 空表格（无表头/叙述性区域）→ 支持多种 Markdown 格式匹配
    2. 普通表格 → 比例评分匹配，不再要求全部列名都匹配
    3. 已匹配的 Markdown 表格被标记后不再重复匹配
    """
    ns = {'w': 'http://schemas.openxmlformats.org/wordprocessingml/2006/main'}
    try:
        root = ET.fromstring(xml_content)
    except ET.ParseError:
        return xml_content

    tables = root.findall('.//w:tbl', ns)
    if not tables or not md_tables:
        return xml_content

    matched_md_indices = set()
    matched_empty_rows = set()

    print(f"[fill_xml_tables_all] 开始匹配: {len(tables)} 个 Word 表格 × {len(md_tables)} 个 Markdown 表格")

    for table_idx, table in enumerate(tables):
        doc_headers = _get_table_headers_from_xml(table)
        doc_headers_non_empty = [h for h in doc_headers if h.strip()]
        is_empty_table = not doc_headers_non_empty

        # ── 空表格处理 ──
        if is_empty_table:
            if _try_match_empty_table(table, root, ns, md_tables, matched_empty_rows):
                title = _get_table_title_before(table, root)
                print(f"[fill_xml_tables_all] 表{table_idx}: 空表格匹配成功, 标题='{title[:30]}'")
            continue

        # ── 普通表格：找最佳匹配的 Markdown 表格 ──
        best_score = 0
        best_md_idx = -1
        best_md_table = None
        for md_idx, md_table in enumerate(md_tables):
            if md_idx in matched_md_indices:
                continue
            md_headers = md_table.get("headers", [])
            score = _calculate_match_score(doc_headers, md_headers)
            if score > best_score:
                best_score = score
                best_md_idx = md_idx
                best_md_table = md_table

        if best_md_idx < 0 or best_score <= 0:
            print(f"[fill_xml_tables_all] 表{table_idx}: 未找到匹配 (headers={doc_headers[:4]}...)")
            continue

        matched_md_indices.add(best_md_idx)
        md_headers = best_md_table.get("headers", [])
        md_rows = best_md_table.get("rows", [])
        trs = table.findall('.//w:tr', ns)

        # ── 列映射：md_headers 列 → doc_headers 列 ──
        col_mapping = {}
        for md_col_idx, md_header in enumerate(md_headers):
            if not md_header.strip():
                continue  # 跳过空表头
            best_match_score = 0
            best_doc_col_idx = -1
            for doc_col_idx, doc_header in enumerate(doc_headers):
                if not doc_header.strip():
                    continue  # 跳过空表头
                doc_norm = _normalize_simple(doc_header)
                md_norm = _normalize_simple(md_header)
                score = 0
                if doc_norm == md_norm:
                    score = 100
                elif len(doc_norm) >= 2 and len(md_norm) >= 2:
                    if doc_norm in md_norm or md_norm in doc_norm:
                        score = 80
                if score > best_match_score:
                    best_match_score = score
                    best_doc_col_idx = doc_col_idx
            if best_match_score >= 50:
                col_mapping[md_col_idx] = best_doc_col_idx

        print(f"[fill_xml_tables_all] 表{table_idx}: 匹配 md_table#{best_md_idx}, score={best_score}, "
              f"col_mapping={col_mapping}, rows={len(md_rows)}, doc_rows={len(trs)-1}")

        # ── 填充数据 ──
        header_tr = trs[0]  # 表头行，用于复制模板
        if len(trs) <= 1:
            # Word 表格只有表头行，需要新增行
            print(f"[fill_xml_tables_all] 表{table_idx}: 仅有表头行，需创建 {len(md_rows)} 行新数据")
            for row_idx, row_data in enumerate(md_rows):
                new_tr = _deep_copy_element(header_tr)
                # 先清空所有单元格中的表头残留文本
                for tc in new_tr.findall('.//w:tc', ns):
                    _clear_cell_text(tc)
                table.append(new_tr)
                tcs = new_tr.findall('.//w:tc', ns)
                filled_in_row = 0
                for md_col_idx, doc_col_idx in col_mapping.items():
                    if md_col_idx < len(row_data) and doc_col_idx < len(tcs):
                        val = row_data[md_col_idx]
                        if val and val.strip():
                            _fill_table_cell(tcs[doc_col_idx], val)
                            filled_in_row += 1
                print(f"[fill_xml_tables_all] 表{table_idx}: 新行{row_idx+1} 填充 {filled_in_row} 个非空单元格, tcs数={len(tcs)}, col_map数={len(col_mapping)}")
        else:
            # Word 表格有数据行，逐行填充
            # 支持动态扩展：如果 md_rows 超过 Word 表格行数，复制表头行创建新行
            for row_idx, row_data in enumerate(md_rows):
                if row_idx + 1 >= len(trs):
                    # Word 表格行数不够，复制表头行来扩展
                    new_tr = _deep_copy_element(header_tr)
                    # 先清空所有单元格中的表头残留文本
                    for tc in new_tr.findall('.//w:tc', ns):
                        _clear_cell_text(tc)
                    table.append(new_tr)
                    trs = table.findall('.//w:tr', ns)  # 重新获取，因为 append 后 trs 是live的
                    tr = new_tr
                    tcs = tr.findall('.//w:tc', ns)
                    filled_in_row = 0
                    for md_col_idx, doc_col_idx in col_mapping.items():
                        if md_col_idx < len(row_data) and doc_col_idx < len(tcs):
                            val = row_data[md_col_idx]
                            if val and val.strip():
                                _fill_table_cell(tcs[doc_col_idx], val)
                                filled_in_row += 1
                    print(f"[fill_xml_tables_all] 表{table_idx}: 动态扩展第 {row_idx + 1} 行（原 {len(trs) - 1} 行 → {len(trs)} 行）, 填充 {filled_in_row} 个单元格")
                else:
                    tr = trs[row_idx + 1]
                    tcs = tr.findall('.//w:tc', ns)
                    filled_in_row = 0
                    for md_col_idx, doc_col_idx in col_mapping.items():
                        if md_col_idx < len(row_data) and doc_col_idx < len(tcs):
                            val = row_data[md_col_idx]
                            if val and val.strip():
                                _fill_table_cell(tcs[doc_col_idx], val)
                                filled_in_row += 1

    unmatched_md = set(range(len(md_tables))) - matched_md_indices
    if unmatched_md:
        for md_idx in unmatched_md:
            md_h = md_tables[md_idx].get("headers", [])
            print(f"[fill_xml_tables_all] Markdown 表#{md_idx} 未匹配到 Word 表格 (headers={md_h[:4]}...)")

    return ET.tostring(root, encoding='unicode', method='xml')
