"""
FastAPI Word文档填表服务
功能：接收docx文件和markdown表格数据，填充到Word文档后返回
支持多表格解析和智能匹配
"""

from fastapi import FastAPI, UploadFile, File, Form, Body, Request, HTTPException
from fastapi.responses import FileResponse
from fastapi.middleware.cors import CORSMiddleware
import zipfile
import xml.etree.ElementTree as ET
from io import BytesIO
import base64
import re
import os
import tempfile
import json
import time
import uuid
from typing import Optional, List, Dict
from datetime import datetime, timedelta

# ==================== 临时文件存储（5分钟有效期） ====================
TEMP_FILES: Dict[str, dict] = {}  # token -> {filepath, filename, expires_at}
TEMP_EXPIRY_SECONDS = 300  # 5分钟

def cleanup_expired_files():
    """清理过期的临时文件"""
    now = time.time()
    expired_tokens = [token for token, info in TEMP_FILES.items() if info["expires_at"] < now]
    for token in expired_tokens:
        try:
            if os.path.exists(TEMP_FILES[token]["filepath"]):
                os.remove(TEMP_FILES[token]["filepath"])
        except Exception:
            pass
        del TEMP_FILES[token]

def create_temp_file(content: bytes, original_filename: str) -> str:
    """创建临时文件，返回token"""
    # 定期清理
    cleanup_expired_files()

    token = str(uuid.uuid4())
    ext = os.path.splitext(original_filename)[1] or ".docx"
    temp_dir = tempfile.gettempdir()
    filepath = os.path.join(temp_dir, f"zotero_fill_{token}{ext}")

    with open(filepath, "wb") as f:
        f.write(content)

    TEMP_FILES[token] = {
        "filepath": filepath,
        "filename": original_filename,
        "expires_at": time.time() + TEMP_EXPIRY_SECONDS
    }

    print(f"[create_temp_file] 创建临时文件: {token} -> {filepath}, 有效期5分钟")
    return token

def get_temp_file(token: str) -> Optional[dict]:
    """获取临时文件信息，过期返回None"""
    if token not in TEMP_FILES:
        return None
    if TEMP_FILES[token]["expires_at"] < time.time():
        # 已过期，清理
        try:
            if os.path.exists(TEMP_FILES[token]["filepath"]):
                os.remove(TEMP_FILES[token]["filepath"])
        except Exception:
            pass
        del TEMP_FILES[token]
        return None
    return TEMP_FILES[token]


def _repair_zip(corrupted_data: bytes) -> Optional[bytes]:
    """
    尝试修复损坏的ZIP文件
    通过扫描本地文件头（PK\x03\x04）重建ZIP
    返回修复后的数据，如果失败返回None
    """
    import struct
    
    files_found = []
    pos = 0
    
    while pos < len(corrupted_data) - 4:
        # 查找本地文件头签名
        if corrupted_data[pos:pos+4] == b'PK\x03\x04':
            try:
                # 解析本地文件头
                # 结构: signature(4) + version(2) + flags(2) + compression(2) + mod_time(2) + mod_date(2) + crc32(4) + compressed_size(4) + uncompressed_size(4) + filename_len(2) + extra_len(2)
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
                    # 数据不完整，尝试截断或跳过
                    # 对于某些压缩类型，我们可以从后续数据中恢复
                    # 但这里为了简单，直接使用剩余数据
                    pos += 4
                    continue
                
                filename = corrupted_data[filename_start:filename_end].decode('utf-8', errors='ignore')
                data = corrupted_data[data_start:data_end]
                
                # 跳过目录
                if not filename.endswith('/'):
                    files_found.append({
                        'name': filename,
                        'data': data,
                        'compression': compression,
                        'compressed_size': compressed_size,
                        'uncompressed_size': uncompressed_size,
                        'crc32': crc32,
                        'pos': pos
                    })
                
                # 移动到下一个文件
                pos = data_end
            except Exception as e:
                pos += 4
                continue
        else:
            pos += 1
    
    if not files_found:
        return None
    
    print(f"[_repair_zip] 找到 {len(files_found)} 个文件，开始重建ZIP...")
    
    # 重建ZIP文件
    output = BytesIO()
    with zipfile.ZipFile(output, 'w', zipfile.ZIP_DEFLATED) as zf:
        for file_info in files_found:
            try:
                zf.writestr(file_info['name'], file_info['data'])
            except Exception as e:
                print(f"[_repair_zip] 写入文件 {file_info['name']} 失败: {e}")
                continue
    
    return output.getvalue()


app = FastAPI(title="Word文档填表服务")

# 添加CORS支持
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# ─── 挂载 LangGraph Agent 路由 ───────────────────────────
try:
    from api.agent_routes import router as agent_router
    app.include_router(agent_router)
    print("[Agent] LangGraph Agent 路由已挂载 (/agent/*)")
except ImportError as e:
    print(f"[Agent] Agent 路由加载失败（缺少依赖）: {e}")

# ─── 挂载 Knowledge Base 路由 ────────────────────────────
try:
    from api.kb_routes import router as kb_router
    app.include_router(kb_router)
    print("[KB] 知识库路由已挂载 (/kb/*)")
except ImportError as e:
    print(f"[KB] 知识库路由加载失败（缺少依赖）: {e}")

# ─── 首次启动自动初始化知识库 ─────────────────────────────
try:
    from kb import init_kb, get_kb
    kb = init_kb()
    stats = kb.get_document_stats()
    print(f"[KB] 知识库已初始化 | 论文: {stats.get('zotero_items', 0)} | 项目: {stats.get('academic_form_projects', 0)} | 专利: {stats.get('academic_form_patents', 0)} | 文档分块: {stats.get('kb_documents_chunks', 0)}")
except Exception as e:
    print(f"[KB] 知识库初始化失败: {e}")


# ==================== 下载端点 ====================
@app.get("/download/{token}")
async def download_file(token: str):
    """下载临时文件（5分钟有效期）"""
    info = get_temp_file(token)
    if not info:
        raise HTTPException(status_code=404, detail="文件已过期或不存在，请重新生成")

    filepath = info["filepath"]
    filename = info["filename"]

    print(f"[download] 发送文件: {filename} (token: {token})")

    return FileResponse(
        path=filepath,
        filename=filename,
        media_type="application/vnd.openxmlformats-officedocument.wordprocessingml.document"
    )


def parse_markdown_tables(markdown: str) -> tuple:
    """解析markdown中的所有表格，空表格填充作为普通表格返回"""
    markdown = markdown.strip()
    
    # 不再单独提取空表格区域，所有表格统一解析
    tables = _extract_tables_from_markdown(markdown)
    
    # 返回空字典，因为空表格现在已作为普通表格处理
    return tables, {}


def _extract_tables_from_markdown(markdown: str) -> List[dict]:
    """从markdown中提取表格（内部函数）"""
    
    # 尝试检测单行多表格格式
    # 特征：用空格分隔多个表格，每个表格以 | ---- | 分隔
    if '\n' not in markdown:
        # 单行格式: | 表头 | | 表头 | | ---- | ---- | | 数据 | | 数据 |
        # 统计分隔符行数量
        separator_count = len(re.findall(r'\|\s*[-:]+\s*\|', markdown))
        
        if separator_count >= 2:
            # 转换为多行格式
            # 1. 把 | ---- | 替换为换行分隔符
            # 2. 把 | | (双竖线中间只有空格) 替换为换行
            
            # 策略：把 " | | " 替换为换行来分隔表格
            # 但先要保留表格内部的结构
            
            # 简单方法：把分隔符行转为真正的换行
            # | ---- | | ---- |  -> \n---\n---\n
            marked = re.sub(r'(\|\s*[-:]+\s*\|)\s*(\|\s*[-:]+\s*\|)', r'\n---\n\2', markdown)
            marked = re.sub(r'(\|\s*[-:]+\s*\|)', r'\n---\n', marked)
            
            # 把表格之间的 | | 转为换行
            marked = re.sub(r'\|\s*\|\s*', '\n', marked)
            
            # 现在按分隔符分割
            blocks = marked.split(r'\n---\n')
            
            tables = []
            for block in blocks:
                block = block.strip()
                if not block:
                    continue
                
                lines = block.split('\n')
                headers = []
                rows = []
                
                is_header = True
                for line in lines:
                    line = line.strip()
                    if not line or not line.startswith('|'):
                        continue
                    
                    # 跳过分割线
                    if re.match(r'^\|[\s\-:|]+\|$', line):
                        is_header = False
                        continue
                    
                    # 解析单元格
                    cells = [cell.strip() for cell in line.split('|')[1:-1]]
                    # 过滤空单元格
                    cells = [c for c in cells if c]
                    
                    if is_header:
                        headers = cells
                        is_header = False
                    elif cells:
                        rows.append(cells)
                
                if headers or rows:
                    tables.append({"headers": headers, "rows": rows})
            
            if tables:
                print(f"  [单行解析] 找到 {len(tables)} 个表格")
                return tables
    
    # 原有逻辑：按空行分割
    table_blocks = re.split(r'\n\s*\n', markdown)
    tables = []
    
    for block in table_blocks:
        block = block.strip()
        if not block:
            continue
        
        lines = block.split('\n')
        headers = []
        rows = []
        
        is_header = True
        for line in lines:
            line = line.strip()
            if not line or not line.startswith('|'):
                continue
            
            # 跳过分割线
            if re.match(r'^\|[\s\-:|]+\|$', line):
                is_header = False
                continue
            
            # 解析单元格
            cells = [cell.strip() for cell in line.split('|')[1:-1]]
            if is_header:
                headers = cells
                is_header = False
            else:
                rows.append(cells)
        
        if headers or rows:
            tables.append({"headers": headers, "rows": rows})
    
    # 最终检查
    print(f"  [解析结果] 共 {len(tables)} 个表格")
    for i, t in enumerate(tables):
        print(f"    表格{i+1}: {len(t['headers'])}列, {len(t['rows'])}行")
        if t['headers']:
            print(f"      表头: {t['headers'][:3]}...")
    
    return tables


def parse_single_markdown_table(markdown: str) -> dict:
    """解析单个markdown表格（兼容旧接口）"""
    tables, _ = parse_markdown_tables(markdown)
    if tables:
        return tables[0]
    return {"headers": [], "rows": []}


def get_table_headers_from_xml(table) -> List[str]:
    """从XML表格中提取表头，保留空列以维持列对齐"""
    namespaces = {'w': 'http://schemas.openxmlformats.org/wordprocessingml/2006/main'}
    
    trs = table.findall('.//w:tr', namespaces)
    if not trs:
        return []
    
    # 第一行是表头
    header_row = trs[0]
    headers = []
    
    for tc in header_row.findall('.//w:tc', namespaces):
        # 获取单元格文本
        text_elem = tc.find('.//w:t', namespaces)
        if text_elem is not None and text_elem.text:
            headers.append(text_elem.text.strip())
        else:
            headers.append('')  # 保留空列
    
    return headers


def calculate_match_score(doc_headers: List[str], md_headers: List[str]) -> float:
    """计算表格匹配分数，更智能的匹配"""
    if not doc_headers or not md_headers:
        return 0
    
    score = 0
    
    # 1. 列数匹配（允许±1的差异）
    if len(doc_headers) == len(md_headers):
        score += 10
    elif abs(len(doc_headers) - len(md_headers)) <= 1:
        score += 5
    
    # 2. 表头内容匹配（忽略空格和特殊字符）
    def normalize(text: str) -> str:
        """规范化表头文本：去空格、去特殊字符、转小写"""
        import unicodedata
        # 去除空格和特殊空白字符
        text = ''.join(c for c in text if not c.isspace())
        # 转小写
        text = text.lower()
        # 去除标点符号
        text = re.sub(r'[^\w\u4e00-\u9fff]+', '', text)
        return text
    
    doc_normalized = [normalize(h) for h in doc_headers]
    md_normalized = [normalize(h) for h in md_headers]
    
    # 完全匹配：每个md列都必须在doc中找到匹配
    matched_count = 0
    
    for md_h in md_normalized:
        for doc_h in doc_normalized:
            # 完全相等
            if doc_h == md_h:
                matched_count += 1
                break
            # 或者doc完全包含md（去除空格后）
            elif len(doc_h) >= 2 and len(md_h) >= 2:
                if doc_h in md_h or md_h in doc_h:
                    matched_count += 1
                    break
    
    # 完全匹配：所有md列都找到匹配
    if matched_count == len(md_headers) and len(md_headers) > 0:
        if len(doc_headers) == len(md_headers):
            return 50  # 完美匹配
        elif len(doc_headers) > len(md_headers):
            return 40  # doc列更多，但所有md列都匹配了
        else:
            return 30
    
    return 0


def fill_table_cell(cell_element, value: str):
    """填充表格单元格"""
    namespaces = {'w': 'http://schemas.openxmlformats.org/wordprocessingml/2006/main'}
    
    # 查找现有的w:t元素
    text_elem = cell_element.find('.//w:t', namespaces)
    if text_elem is not None:
        text_elem.text = value
        print(f"      [填充单元格] 更新文本: {value}")
    else:
        # 如果没有w:t元素，创建完整的结构: w:p -> w:r -> w:t
        p = cell_element.find('.//w:p', namespaces)
        if p is None:
            # 创建w:p
            p = ET.SubElement(cell_element, '{http://schemas.openxmlformats.org/wordprocessingml/2006/main}p')
        
        # 创建w:r
        r = ET.SubElement(p, '{http://schemas.openxmlformats.org/wordprocessingml/2006/main}r')
        
        # 创建w:t
        text_elem = ET.SubElement(r, '{http://schemas.openxmlformats.org/wordprocessingml/2006/main}t')
        text_elem.text = value
        text_elem.set('{http://www.w3.org/XML/1998/namespace}space', 'preserve')
        
        print(f"      [填充单元格] 创建新文本节点: {value}")


def get_table_title_before(table, root) -> str:
    """获取表格前面的标题文本"""
    namespaces = {'w': 'http://schemas.openxmlformats.org/wordprocessingml/2006/main'}
    
    # 找到表格在DOM中的位置
    body = root.find('.//w:body', namespaces)
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
    
    # 向前查找最近的标题段落
    for i in range(table_idx - 1, -1, -1):
        elem = elements[i]
        if elem.tag == '{http://schemas.openxmlformats.org/wordprocessingml/2006/main}tbl':
            # 遇到上一个表格，停止
            break
        
        if elem.tag == '{http://schemas.openxmlformats.org/wordprocessingml/2006/main}p':
            # 检查段落是否包含标题样式或大文本
            pPr = elem.find('w:pPr', namespaces)
            if pPr is not None:
                pStyle = pPr.find('w:pStyle', namespaces)
                if pStyle is not None:
                    style_val = pStyle.get('{http://schemas.openxmlformats.org/wordprocessingml/2006/main}val', '')
                    if 'Heading' in style_val or 'Title' in style_val or 'TOC' in style_val:
                        # 获取段落文本
                        texts = elem.findall('.//w:t', namespaces)
                        if texts:
                            return ''.join([t.text or '' for t in texts]).strip()
            
            # 检查段落是否是大字体文本（可能是标题）
            texts = elem.findall('.//w:t', namespaces)
            if texts:
                para_text = ''.join([t.text or '' for t in texts]).strip()
                if para_text and len(para_text) < 100:  # 标题通常较短
                    return para_text
    
    return ""


def fill_empty_table_by_title(table, title: str, content: str, namespaces):
    """根据标题填充空表格"""
    # 获取表格的所有行
    trs = table.findall('.//w:tr', namespaces)
    
    if not trs:
        print(f"    [空表格] 表格无任何行")
        return False
    
    # 检查表格是否真的是空表格（只有一行或表头为空）
    doc_headers = get_table_headers_from_xml(table)
    is_empty_table = len(trs) <= 1 or not any(h.strip() for h in doc_headers)
    
    if not is_empty_table:
        print(f"    [空表格] 表格有实际表头 '{doc_headers}'，不是空表格")
        return False
    
    print(f"    [空表格] 匹配到标题: '{title}'")
    print(f"    [空表格] 填充内容: {content[:100]}...")
    
    # 空表格只有表头行，直接用内容填充表头行的第一个单元格
    # 不创建新行
    header_tr = trs[0]
    tcs = header_tr.findall('.//w:tc', namespaces)
    
    if tcs:
        fill_table_cell(tcs[0], content)
        print(f"    [空表格] 已填充到单元格")
        return True
    
    return False


def normalize_simple(text: str) -> str:
    """规范化表头文本：去空格、去特殊字符、转小写"""
    text = ''.join(c for c in text if not c.isspace())
    text = text.lower()
    text = re.sub(r'[^\w\u4e00-\u9fff]+', '', text)
    return text


def fill_xml_tables_all(xml_content: str, md_tables: List[dict]) -> str:
    """用markdown表格数据填充XML中的所有表格"""
    
    print(f"  收到 {len(md_tables)} 个markdown表格")
    
    namespaces = {'w': 'http://schemas.openxmlformats.org/wordprocessingml/2006/main'}
    
    try:
        root = ET.fromstring(xml_content)
    except ET.ParseError as e:
        print(f"XML解析错误: {e}")
        return xml_content
    
    tables = root.findall('.//w:tbl', namespaces)
    print(f"  Word文档中有 {len(tables)} 个表格")
    
    if not tables:
        return xml_content
    
    # 为每个Word表格找到最佳匹配的markdown表格
    matched_md_indices = set()  # 已匹配的普通markdown表格索引
    matched_empty_rows = set()   # 已匹配的空表格行索引，格式为 (md_idx, row_idx)
    
    for table_idx, table in enumerate(tables):
        # 获取当前Word表格的表头
        doc_headers = get_table_headers_from_xml(table)
        
        # 判断是否为真正的空表格（无表头行，或表头全为空）
        is_empty_table = not doc_headers or not any(h.strip() for h in doc_headers)
        
        if is_empty_table:
            # 无表头或表头为空的表格，尝试用空表格格式的markdown表格填充
            # 空表格格式：表头为 ["表格标题", "填充内容"]
            print(f"  表格 {table_idx + 1}: 空表格，尝试匹配")
            
            # 获取表格前的标题
            table_title = get_table_title_before(table, root)
            print(f"    表格前标题: '{table_title}'")
            
            matched = False
            # 遍历 markdown 表格，找到空表格格式的
            for md_idx, md_table in enumerate(md_tables):
                md_headers = md_table.get("headers", [])
                # 检查是否是空表格格式：表头只有两列，且列名为"表格标题"和"填充内容"
                if len(md_headers) == 2:
                    header_norm = [normalize_simple(h) for h in md_headers]
                    if "表格标题" in header_norm[0] and "填充内容" in header_norm[1]:
                        # 找到了空表格格式的 markdown 表格
                        md_rows = md_table.get("rows", [])
                        if md_rows:
                            # 遍历数据行，找到匹配的标题
                            for row_idx, md_row in enumerate(md_rows):
                                if len(md_row) >= 2:
                                    # 检查这行是否已经被匹配过了
                                    if (md_idx, row_idx) in matched_empty_rows:
                                        continue
                                    
                                    md_title = md_row[0]
                                    md_content = md_row[1]
                                    doc_norm = normalize_simple(table_title)
                                    md_title_norm = normalize_simple(md_title)
                                    # 支持部分匹配
                                    if doc_norm == md_title_norm or md_title_norm in doc_norm or doc_norm in md_title_norm:
                                        if fill_empty_table_by_title(table, table_title, md_content, namespaces):
                                            matched_empty_rows.add((md_idx, row_idx))
                                            print(f"    空表格 '{table_title}' 匹配到 '{md_title}' 并填充成功")
                                            matched = True
                                            break
                            if matched:
                                break
            if not matched:
                print(f"    未找到匹配的空表格markdown表格，当前标题: '{table_title}'")
            continue
        
        print(f"  表格 {table_idx + 1} 表头: {doc_headers}")
        
        # 找到最佳匹配的markdown表格（遍历所有md_tables）
        best_score = 0
        best_md_idx = -1
        best_md_table = None
        
        for md_idx, md_table in enumerate(md_tables):
            if md_idx in matched_md_indices:
                continue
            
            md_headers = md_table.get("headers", [])
            
            # 使用表头进行匹配
            score = calculate_match_score(doc_headers, md_headers)
            print(f"    vs md表格{md_idx+1}: {md_headers}, 分数={score}")
            
            if score > best_score:
                best_score = score
                best_md_idx = md_idx
                best_md_table = md_table
        
        # 如果找到匹配，填充数据
        if best_md_idx >= 0 and best_score > 0:
            matched_md_indices.add(best_md_idx)
            
            md_headers = best_md_table.get("headers", [])
            md_rows = best_md_table.get("rows", [])
            
            # 填充表格数据
            trs = table.findall('.//w:tr', namespaces)
            print(f"  匹配成功! 分数={best_score}, 填充 {len(md_rows)} 行数据到表格 {table_idx + 1}")
            
            # 建立markdown列索引到Word列索引的映射
            col_mapping = {}
            
            for md_col_idx, md_header in enumerate(md_headers):
                best_match_score = 0
                best_doc_col_idx = -1
                
                for doc_col_idx, doc_header in enumerate(doc_headers):
                    doc_norm = normalize_simple(doc_header)
                    md_norm = normalize_simple(md_header)
                    
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
            
            print(f"    列映射 (md->word): {col_mapping}")
            
            if len(trs) <= 1:
                # 只有表头没有数据行，需要添加新行
                header_tr = trs[0]
                
                for row_idx, row_data in enumerate(md_rows):
                    new_tr = ET.Element(header_tr.tag, header_tr.attrib)
                    
                    header_tcs = header_tr.findall('.//w:tc', namespaces)
                    for tc in header_tcs:
                        new_tc = ET.SubElement(new_tr, tc.tag, tc.attrib)
                        for child in tc:
                            new_child = ET.SubElement(new_tc, child.tag, child.attrib)
                            for grandchild in child:
                                ET.SubElement(new_child, grandchild.tag, grandchild.attrib)
                    
                    table.append(new_tr)
                    
                    tcs = new_tr.findall('.//w:tc', namespaces)
                    
                    for md_col_idx, doc_col_idx in col_mapping.items():
                        if md_col_idx < len(row_data) and doc_col_idx < len(tcs):
                            cell_value = row_data[md_col_idx]
                            fill_table_cell(tcs[doc_col_idx], cell_value)
            else:
                # 从第二行开始填充
                for row_idx, row_data in enumerate(md_rows):
                    if row_idx + 1 >= len(trs):
                        break
                    
                    tr = trs[row_idx + 1]
                    tcs = tr.findall('.//w:tc', namespaces)
                    
                    for md_col_idx, doc_col_idx in col_mapping.items():
                        if md_col_idx < len(row_data) and doc_col_idx < len(tcs):
                            cell_value = row_data[md_col_idx]
                            fill_table_cell(tcs[doc_col_idx], cell_value)
            
            print(f"  表格 {table_idx + 1}: 填充完成")
        else:
            print(f"  表格 {table_idx + 1}: 未找到匹配 (最高分数: {best_score})")
    
    return ET.tostring(root, encoding='unicode', method='xml')


def fill_xml_tables_simple(xml_content: str, table_data: dict) -> str:
    """简单的表格填充 - 按顺序填充（兼容旧逻辑）"""
    headers = table_data.get("headers", [])
    rows = table_data.get("rows", [])

    if not headers or not rows:
        return xml_content

    namespaces = {'w': 'http://schemas.openxmlformats.org/wordprocessingml/2006/main'}

    try:
        root = ET.fromstring(xml_content)
    except ET.ParseError as e:
        print(f"XML解析错误: {e}")
        return xml_content

    tables = root.findall('.//w:tbl', namespaces)

    # 按顺序填充每个表格
    table_idx = 0
    for table in tables:
        if table_idx >= len(rows):
            break

        trs = table.findall('.//w:tr', namespaces)
        if len(trs) == 0:
            continue

        # 第一行通常是表头，从第二行开始填充数据
        for row_idx, row_data in enumerate(rows):
            if row_idx + 1 >= len(trs):
                break

            tr = trs[row_idx + 1]  # 跳过表头行
            tcs = tr.findall('.//w:tc', namespaces)

            for col_idx, cell_data in enumerate(row_data):
                if col_idx >= len(tcs):
                    break
                fill_table_cell(tcs[col_idx], cell_data)

        table_idx += 1

    return ET.tostring(root, encoding='unicode', method='xml')


@app.get("/")
async def root():
    return {"message": "Word文档填表服务", "version": "2.0.0", "agent_version": "3.0.0"}


@app.post("/fill")
async def fill_document(
    file: UploadFile = File(..., description="Word文档(.docx)"),
    papers_markdown: str = Form(..., description="markdown格式的表格数据")
):
    """填充Word文档"""
    content = await file.read()

    # 解析markdown表格数据和空表格填充信息
    tables, _ = parse_markdown_tables(papers_markdown)
    print(f"解析到 {len(tables)} 个表格（空表格已转为标准格式）")

    input_zip = BytesIO(content)
    output_zip = BytesIO()

    try:
        with zipfile.ZipFile(input_zip, 'r') as z_in:
            with zipfile.ZipFile(output_zip, 'w', zipfile.ZIP_DEFLATED) as z_out:
                for item in z_in.infolist():
                    data = z_in.read(item.filename)

                    if item.filename == 'word/document.xml':
                        xml_content = data.decode('utf-8')
                        
                        # 使用多表格填充
                        xml_content = fill_xml_tables_all(xml_content, tables)
                        
                        data = xml_content.encode('utf-8')
                        print(f"已处理: {item.filename}")

                    z_out.writestr(item, data)

        output_zip.seek(0)

        with tempfile.NamedTemporaryFile(suffix='.docx', delete=False) as tmp:
            tmp.write(output_zip.getvalue())
            tmp_path = tmp.name

        return FileResponse(
            tmp_path,
            media_type='application/vnd.openxmlformats-officedocument.wordprocessingml.document',
            filename=f"filled_{file.filename}"
        )

    except Exception as e:
        return {"error": str(e)}


@app.post("/fill_base64")
async def fill_document_base64(request: Request):
    """填充Word文档（Base64版本）- 支持 Form 和 JSON 两种格式"""
    
    # 尝试解析 JSON 请求体
    content_type = request.headers.get("content-type", "")
    
    # 📝 关键调试：保存原始请求体用于诊断
    raw_body = None
    if "application/json" in content_type:
        try:
            raw_body = await request.body()
            print(f"[fill_base64] 原始请求体大小: {len(raw_body)} bytes")
            
            # 重新解析 JSON（因为 request.json() 只能调用一次）
            body = json.loads(raw_body)
            docx_base64 = body.get("docx_base64", "")
            papers_markdown = body.get("papers_markdown", "")
        except Exception as e:
            print(f"[fill_base64] JSON 解析失败: {e}")
            return {"success": False, "error": f"JSON 解析失败: {e}"}
    else:
        # Form 格式
        form = await request.form()
        docx_base64 = form.get("docx_base64", "")
        papers_markdown = form.get("papers_markdown", "")
    
    print(f"[fill_base64] 收到请求 | Content-Type: {content_type}")
    print(f"[fill_base64] docx_base64长度: {len(docx_base64) if docx_base64 else 0}")
    print(f"[fill_base64] papers_markdown长度: {len(papers_markdown) if papers_markdown else 0}")
    
    if docx_base64:
        # 验证 base64 有效性和 ZIP 文件结构
        try:
            # 检查 base64 的前几个字符（应该是有效的 base64）
            test_chars = docx_base64[:100]
            print(f"[fill_base64] base64 前100字符: {test_chars}")
            
            # 尝试解码并检查 ZIP 头
            test_bytes = base64.b64decode(docx_base64[:1000])
            print(f"[fill_base64] base64 头部 1000 字符解码成功，前4字节（ZIP头）: {test_bytes[:4].hex()}")
        except Exception as e:
            print(f"[fill_base64] base64 头部验证失败: {e}")
    
    if not docx_base64 or not papers_markdown:
        return {"success": False, "error": f"缺少必要参数 | docx_base64: {len(docx_base64) if docx_base64 else 0}, papers_markdown: {len(papers_markdown) if papers_markdown else 0}"}
    
    try:
        content = base64.b64decode(docx_base64)
        print(f"[fill_base64] base64解码成功 | 解码后大小: {len(content)} bytes")
        
        # ⚠️ 关键检查：验证 ZIP 文件的完整性
        print(f"[fill_base64] ZIP 文件前 4 字节: {content[:4].hex()}")
        print(f"[fill_base64] ZIP 文件后 4 字节: {content[-4:].hex()}")
        
        # 检查文件大小是否合理
        if len(content) < 1000:
            print(f"[fill_base64] ⚠️ 警告：ZIP 文件太小（{len(content)} bytes），可能被截断！")
            return {"success": False, "error": f"DOCX文件被截断（仅{len(content)}字节）"}
        
        # 首先尝试正常打开ZIP文件
        zip_valid = False
        try:
            test_zip = BytesIO(content)
            with zipfile.ZipFile(test_zip, 'r', allowZip64=True) as z_in:
                print(f"[fill_base64] ZIP文件打开成功，包含 {len(z_in.namelist())} 个文件")
                zip_valid = True
        except zipfile.BadZipFile as e:
            print(f"[fill_base64] ⚠️ ZIP文件格式错误: {e}，尝试修复...")
            # 使用 _repair_zip 修复损坏的ZIP
            repaired_content = _repair_zip(content)
            if repaired_content is None:
                print(f"[fill_base64] ❌ ZIP文件无法修复")
                return {"success": False, "error": f"DOCX文件损坏且无法修复: {e}"}
            else:
                content = repaired_content
                print(f"[fill_base64] ✅ ZIP文件修复成功，修复后大小: {len(content)} bytes")
                zip_valid = True
    
    except Exception as e:
        import traceback
        print(f"[fill_base64] base64解码失败: {e}")
        traceback.print_exc()
        return {"success": False, "error": f"base64解码失败: {e}", "trace": traceback.format_exc()}

    # 解析markdown表格数据和空表格填充信息
    tables, empty_table_fillings = parse_markdown_tables(papers_markdown)
    print(f"[fill_base64] 解析到 {len(tables)} 个表格, {len(empty_table_fillings)} 个空表格填充")
    for i, t in enumerate(tables):
        print(f"  表格 {i+1}: {len(t['headers'])} 列, {len(t['rows'])} 行")
        if t['headers']:
            print(f"    表头: {t['headers'][:3]}...")

    input_zip = BytesIO(content)
    output_zip = BytesIO()

    try:
        # 使用 allowZip64=True 支持大文件
        with zipfile.ZipFile(input_zip, 'r', allowZip64=True) as z_in:
            print(f"[fill_base64] ZIP文件打开成功，包含 {len(z_in.namelist())} 个文件")
            with zipfile.ZipFile(output_zip, 'w', zipfile.ZIP_DEFLATED) as z_out:
                for item in z_in.infolist():
                    data = z_in.read(item.filename)

                    if item.filename == 'word/document.xml':
                        xml_content = data.decode('utf-8')
                        
                        # 使用多表格填充
                        xml_content = fill_xml_tables_all(xml_content, tables)
                        
                        data = xml_content.encode('utf-8')
                        print(f"[fill_base64] document.xml 修改成功，新大小: {len(data)} bytes")

                    z_out.writestr(item, data)
                
                print(f"[fill_base64] ZIP文件写入完成")
            
            # ⚠️ 关键修复：在 with 块内部完成所有 ZIP 操作后立即处理数据
            output_zip.seek(0)
        
        # 现在 ZipFile 已关闭，我们可以安全地访问 output_zip 的内容
        zip_bytes = output_zip.getvalue()
        print(f"[fill_base64] ZIP 输出大小: {len(zip_bytes)} bytes")
        print(f"[fill_base64] ZIP 输出头部：{zip_bytes[:4].hex()}")
        
        if len(zip_bytes) == 0:
            print(f"[fill_base64] ⚠️ 警告: output_zip 为空！")
            return {"success": False, "error": "输出ZIP文件为空", "download_url": ""}

        # 生成原始文件名（从请求中获取或使用默认）
        original_filename = "filled_document.docx"

        # 保存到临时文件，返回下载链接
        token = create_temp_file(zip_bytes, original_filename)
        download_url = f"/download/{token}"

        print(f"[fill_base64] 临时文件已创建: {token}")
        print(f"[fill_base64] 下载链接: {download_url}（有效期5分钟）")

        return {
            "success": True,
            "download_url": download_url,
            "filename": original_filename,
            "message": "文件将在5分钟后自动删除，请尽快下载"
        }

    except Exception as e:
        import traceback
        print(f"[fill_base64] 处理失败: {e}")
        traceback.print_exc()
        return {"success": False, "error": str(e), "trace": traceback.format_exc()}


@app.post("/docx_to_text")
async def docx_to_text(request: Request):
    """将DOCX文档转换为文本（Markdown格式），供LLM分析使用"""
    try:
        content_type = request.headers.get("content-type", "")
        if "application/json" in content_type:
            body = await request.json()
            docx_base64 = body.get("docx_base64", "")
        else:
            form = await request.form()
            docx_base64 = form.get("docx_base64", "")
        
        if not docx_base64:
            return {"success": False, "error": "缺少 docx_base64 参数", "text": ""}

        import xml.etree.ElementTree as ET
        
        content = base64.b64decode(docx_base64)
        input_zip = BytesIO(content)
        
        text_parts = []
        
        with zipfile.ZipFile(input_zip, 'r') as z_in:
            # 读取document.xml（主文档内容）
            if 'word/document.xml' in z_in.namelist():
                doc_xml = z_in.read('word/document.xml').decode('utf-8')
                root = ET.fromstring(doc_xml)
                
                # 命名空间
                namespaces = {
                    'w': 'http://schemas.openxmlformats.org/wordprocessingml/2006/main',
                    'w14': 'http://schemas.microsoft.com/office/word/2010/wordml',
                    'mc': 'http://schemas.openxmlformats.org/markup-compatibility/2006',
                    'm': 'http://schemas.openxmlformats.org/officeDocument/2006/math'
                }
                
                # 获取所有段落
                paragraphs = root.findall('.//w:p', namespaces)
                
                for para in paragraphs:
                    # 获取段落中的所有文本
                    texts = para.findall('.//w:t', namespaces)
                    if texts:
                        para_text = ''.join([t.text or '' for t in texts])
                        if para_text.strip():
                            text_parts.append(para_text)
                    
                    # 检查是否是表格的开始（通过检测w:tbl标签）
                    # 如果在段落后面紧跟表格，添加分隔标记
                    # 获取当前段落在DOM中的位置
                
                # 获取所有表格
                tables = root.findall('.//w:tbl', namespaces)
                
                for table_idx, table in enumerate(tables):
                    text_parts.append("")  # 表格前的空行
                    text_parts.append(f"【表格 {table_idx + 1}】")
                    
                    # 获取表头（第一行）
                    trs = table.findall('.//w:tr', namespaces)
                    
                    if trs:
                        # 表头
                        header_cells = trs[0].findall('.//w:tc', namespaces)
                        headers = []
                        for tc in header_cells:
                            texts = tc.findall('.//w:t', namespaces)
                            cell_text = ''.join([t.text or '' for t in texts])
                            headers.append(cell_text.strip() if cell_text.strip() else "空列")
                        
                        # Markdown表头
                        if headers:
                            header_line = "| " + " | ".join(headers) + " |"
                            separator_line = "| " + " | ".join(["---"] * len(headers)) + " |"
                            text_parts.append(header_line)
                            text_parts.append(separator_line)
                        
                        # 数据行
                        for row_idx in range(1, len(trs)):
                            row = trs[row_idx]
                            cells = row.findall('.//w:tc', namespaces)
                            row_data = []
                            
                            for ci, tc in enumerate(cells):
                                texts = tc.findall('.//w:t', namespaces)
                                cell_text = ''.join([t.text or '' for t in texts])
                                # 处理单元格内容
                                cell_text = cell_text.replace('\n', ' ').replace('|', '\\|').strip()
                                if ci < len(headers):  # 只添加有对应表头的列
                                    row_data.append(cell_text if cell_text else " ")
                            
                            if row_data:
                                row_line = "| " + " | ".join(row_data) + " |"
                                text_parts.append(row_line)
                    
                    text_parts.append("")  # 表格后的空行
        
        # 合并所有文本
        full_text = "\n".join(text_parts)
        
        return {
            "success": True,
            "text": full_text,
            "table_count": len(text_parts),
            "char_count": len(full_text)
        }
        
    except Exception as e:
        import traceback
        return {
            "success": False, 
            "error": str(e), 
            "text": ""
        }


# ==================== 启动命令 ====================
# uvicorn main:app --host 0.0.0.0 --port 8000 --reload

if __name__ == "__main__":
    import uvicorn
    print("=" * 50)
    print("Word文档填表服务启动中...")
    print("访问地址: http://zotero-fill.local:8001")
    print("=" * 50)
    uvicorn.run(app, host="0.0.0.0", port=8001)
