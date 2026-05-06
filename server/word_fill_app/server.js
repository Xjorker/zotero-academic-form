/**
 * Node.js Word文档填表服务
 * 使用docx模板和markdown数据填充Word文档
 */

const express = require('express');
const multer = require('multer');
const cors = require('cors');
const { exec } = require('child_process');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = 8000;

// 中间件
app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// 上传配置
const upload = multer({ 
    storage: multer.memoryStorage(),
    limits: { fileSize: 50 * 1024 * 1024 }
});

/**
 * 解析markdown中的多个表格
 * 用分隔符区分不同表格，如 "---表格1---" 和 "---表格2---"
 * 或者自动检测连续的表格区域
 */
function parseMarkdownTables(markdown) {
    // 首先尝试用分隔符分割
    // 支持的分隔符: ---, ===, ***, 表格, Table
    const separatorPatterns = [
        /^---+$/m,
        /^===+$/m,
        /^\*\*\*+$/m,
        /^表格\d*$/m,
        /^Table\d*$/m,
        /^表\d*$/m
    ];
    
    let tables = [];
    let currentTable = [];
    let lines = markdown.trim().split('\n');
    
    // 简单方式：检测连续的|开头行作为表格
    let tableBuffer = [];
    let inTable = false;
    
    for (const line of lines) {
        const trimmed = line.trim();
        
        // 检测是否为表格行
        const isTableLine = trimmed && trimmed.startsWith('|');
        
        if (isTableLine) {
            inTable = true;
            tableBuffer.push(trimmed);
        } else {
            // 非表格行
            if (inTable && tableBuffer.length > 0) {
                // 保存之前的表格
                const parsed = parseSingleMarkdownTable(tableBuffer.join('\n'));
                if (parsed.rows.length > 0 || parsed.headers.length > 0) {
                    tables.push(parsed);
                }
                tableBuffer = [];
            }
            inTable = false;
        }
    }
    
    // 最后一张表格
    if (tableBuffer.length > 0) {
        const parsed = parseSingleMarkdownTable(tableBuffer.join('\n'));
        if (parsed.rows.length > 0 || parsed.headers.length > 0) {
            tables.push(parsed);
        }
    }
    
    return tables;
}

/**
 * 解析单个markdown表格
 */
function parseSingleMarkdownTable(markdownText) {
    const lines = markdownText.trim().split('\n');
    const headers = [];
    const rows = [];

    let isHeader = true;
    for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || !trimmed.startsWith('|')) continue;

        // 跳过分割线
        if (/^\|[\s\-:|]+\|$/.test(trimmed)) {
            isHeader = false;
            continue;
        }

        // 解析单元格
        const cells = trimmed.split('|')
            .map(cell => cell.trim())
            .filter(cell => cell !== '');

        if (isHeader) {
            headers.push(...cells);
        } else if (cells.length > 0) {
            rows.push(cells);
        }
    }

    return { headers, rows };
}

/**
 * 使用Python脚本处理Word文档
 */
function fillWordDocument(docxBuffer, tableData) {
    return new Promise((resolve, reject) => {
        const tempDir = path.join(__dirname, 'temp');
        if (!fs.existsSync(tempDir)) {
            fs.mkdirSync(tempDir, { recursive: true });
        }

        const inputFile = path.join(tempDir, `input_${Date.now()}.docx`);
        const outputFile = path.join(tempDir, `output_${Date.now()}.docx`);
        const dataFile = path.join(tempDir, `data_${Date.now()}.json`);

        // 写入输入文件
        fs.writeFileSync(inputFile, docxBuffer);
        fs.writeFileSync(dataFile, JSON.stringify(tableData));

        // 调用Python处理脚本（多表格智能匹配版本）
        const pythonScript = `
import zipfile
import xml.etree.ElementTree as ET
import json
import sys
import re

input_file = r"${inputFile.replace(/\\/g, '\\\\')}"
output_file = r"${outputFile.replace(/\\/g, '\\\\')}"
data_file = r"${dataFile.replace(/\\/g, '\\\\')}"

# 读取数据（支持多表格）
with open(data_file, 'r', encoding='utf-8') as f:
    table_data = json.load(f)

# 支持多表格: { tables: [{headers: [...], rows: [...]}, ...] }
if isinstance(table_data, dict) and 'tables' in table_data:
    md_tables = table_data['tables']
elif isinstance(table_data, dict):
    # 兼容单表格格式
    md_tables = [table_data]
elif isinstance(table_data, list):
    md_tables = table_data
else:
    md_tables = [table_data]

print(f"Markdown表格数量: {len(md_tables)}")

namespaces = {'w': 'http://schemas.openxmlformats.org/wordprocessingml/2006/main'}

def get_xml_table_headers(table):
    """获取XML表格的表头"""
    trs = table.findall('.//w:tr', namespaces)
    if not trs:
        return []
    
    # 第一行是表头
    header_row = trs[0]
    header_cells = header_row.findall('.//w:tc', namespaces)
    
    headers = []
    for cell in header_cells:
        # 获取单元格内所有文本
        texts = cell.findall('.//w:t', namespaces)
        cell_text = ''.join([t.text or '' for t in texts])
        headers.append(cell_text.strip())
    
    return headers

def get_xml_table_col_count(table):
    """获取XML表格的列数"""
    trs = table.findall('.//w:tr', namespaces)
    if not trs:
        return 0
    
    # 取第一行的单元格数
    first_row = trs[0]
    cells = first_row.findall('.//w:tc', namespaces)
    return len(cells)

def headers_match(xml_headers, md_headers):
    """检查表头是否匹配（忽略大小写、空格）"""
    if len(xml_headers) != len(md_headers):
        return False
    
    for xh, mh in zip(xml_headers, md_headers):
        # 标准化：转小写，去空格，去特殊字符
        xh_norm = re.sub(r'\\s+', '', xh.lower())
        mh_norm = re.sub(r'\\s+', '', mh.lower())
        if xh_norm != mh_norm:
            return False
    
    return True

def fill_single_table(table, md_table):
    """填充单个表格"""
    rows = md_table.get('rows', [])
    if not rows:
        return
    
    trs = table.findall('.//w:tr', namespaces)
    if len(trs) == 0:
        return
    
    # 从第二行开始填充（跳过表头）
    for row_idx, row_data in enumerate(rows):
        if row_idx + 1 >= len(trs):
            break
        
        tr = trs[row_idx + 1]
        tcs = tr.findall('.//w:tc', namespaces)
        
        for col_idx, cell_data in enumerate(row_data):
            if col_idx >= len(tcs):
                break
            
            # 找到或创建w:t元素
            text_elem = tcs[col_idx].find('.//w:t', namespaces)
            if text_elem is None:
                p = tcs[col_idx].find('.//w:p', namespaces)
                if p is not None:
                    r = ET.SubElement(p, '{http://schemas.openxmlformats.org/wordprocessingml/2006/main}r')
                    text_elem = ET.SubElement(r, '{http://schemas.openxmlformats.org/wordprocessingml/2006/main}t')
                else:
                    continue
            
            text_elem.text = cell_data

try:
    # 处理docx文件
    with zipfile.ZipFile(input_file, 'r') as zf:
        # 读取document.xml
        xml_content = zf.read('word/document.xml').decode('utf-8')
        root = ET.fromstring(xml_content)
        
        # 找到所有XML表格
        xml_tables = root.findall('.//w:tbl', namespaces)
        print(f"XML表格数量: {len(xml_tables)}")
        
        # 标记哪些XML表格已被填充
        filled_indices = set()
        
        # 遍历每个markdown表格，匹配并填充
        for md_idx, md_table in enumerate(md_tables):
            md_headers = md_table.get('headers', [])
            md_col_count = len(md_headers)
            
            print(f"Markdown表格 {md_idx + 1}: {md_col_count}列, {len(md_table.get('rows', []))}行")
            
            best_match_idx = -1
            best_match_score = 0
            
            # 遍历XML表格找最佳匹配
            for xml_idx, xml_table in enumerate(xml_tables):
                if xml_idx in filled_indices:
                    continue
                
                xml_headers = get_xml_table_headers(xml_table)
                xml_col_count = get_xml_table_col_count(xml_table)
                
                # 计算匹配分数
                score = 0
                
                # 1. 列数完全匹配
                if xml_col_count == md_col_count:
                    score += 10
                
                # 2. 表头内容匹配
                if headers_match(xml_headers, md_headers):
                    score += 20
                # 3. 部分表头匹配
                elif xml_col_count == md_col_count and xml_headers and md_headers:
                    # 检查是否有50%以上的表头匹配
                    match_count = sum(1 for xh, mh in zip(xml_headers, md_headers) 
                                     if re.sub(r'\\s+', '', xh.lower()) == re.sub(r'\\s+', '', mh.lower()))
                    if match_count >= len(xml_headers) * 0.5:
                        score += 15
                
                if score > best_match_score:
                    best_match_score = score
                    best_match_idx = xml_idx
            
            # 填充最佳匹配的表格
            if best_match_idx >= 0 and best_match_score >= 10:
                print(f"  -> 匹配XML表格 {best_match_idx + 1}, 分数: {best_match_score}")
                fill_single_table(xml_tables[best_match_idx], md_table)
                filled_indices.add(best_match_idx)
            else:
                print(f"  -> 未找到匹配，跳过")
        
        print(f"共填充 {len(filled_indices)} 个表格")
        
        # 写回XML
        filled_xml = ET.tostring(root, encoding='unicode')
        
        # 创建输出文件
        with zipfile.ZipFile(output_file, 'w', zipfile.ZIP_DEFLATED) as out_zf:
            for item in zf.infolist():
                if item.filename == 'word/document.xml':
                    out_zf.writestr(item, filled_xml.encode('utf-8'))
                else:
                    out_zf.writestr(item, zf.read(item.filename))
    
    print("SUCCESS")
except Exception as e:
    import traceback
    print(f"ERROR: {str(e)}", file=sys.stderr)
    traceback.print_exc()
`;

        // 写入并执行Python脚本
        const pyFile = path.join(tempDir, `process_${Date.now()}.py`);
        fs.writeFileSync(pyFile, pythonScript, { encoding: 'utf-8' });

        exec(`python "${pyFile}"`, { cwd: tempDir }, (error, stdout, stderr) => {
            // 清理临时文件
            try {
                fs.unlinkSync(inputFile);
                fs.unlinkSync(dataFile);
                fs.unlinkSync(pyFile);
            } catch (e) {}

            if (error) {
                console.error('Python error:', stderr);
                reject(new Error(stderr || error.message));
                return;
            }

            if (!fs.existsSync(outputFile)) {
                reject(new Error('处理失败：输出文件未生成'));
                return;
            }

            // 读取输出文件
            const outputBuffer = fs.readFileSync(outputFile);
            
            // 清理输出文件
            try {
                fs.unlinkSync(outputFile);
            } catch (e) {}

            resolve(outputBuffer);
        });
    });
}

// 根路由
app.get('/', (req, res) => {
    res.json({ 
        message: 'Word文档填表服务', 
        version: '1.0.0',
        endpoints: {
            fill: 'POST /fill - 文件上传方式',
            fill_base64: 'POST /fill_base64 - Base64方式'
        }
    });
});

// 文件上传方式
app.post('/fill', upload.single('file'), async (req, res) => {
    try {
        if (!req.file) {
            return res.status(400).json({ error: '请上传文件' });
        }

        const papersMarkdown = req.body.papers_markdown || '';
        if (!papersMarkdown) {
            return res.status(400).json({ error: '请提供papers_markdown数据' });
        }

        // 解析多表格
        const mdTables = parseMarkdownTables(papersMarkdown);
        console.log(`解析到 ${mdTables.length} 个表格`);
        
        // 转换为兼容格式
        const tableData = { tables: mdTables };
        console.log(`表格1: ${mdTables[0]?.headers?.length || 0}列, ${mdTables[0]?.rows?.length || 0}行`);

        const filledDocx = await fillWordDocument(req.file.buffer, tableData);

        res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
        res.setHeader('Content-Disposition', `attachment; filename=filled_${req.file.originalname}`);
        res.send(filledDocx);

    } catch (error) {
        console.error('处理错误:', error);
        res.status(500).json({ error: error.message });
    }
});

// Base64方式
app.post('/fill_base64', async (req, res) => {
    try {
        const { docx_base64, papers_markdown } = req.body;

        if (!docx_base64) {
            return res.status(400).json({ error: '请提供docx_base64数据' });
        }

        if (!papers_markdown) {
            return res.status(400).json({ error: '请提供papers_markdown数据' });
        }

        // 解码base64
        const docxBuffer = Buffer.from(docx_base64, 'base64');
        
        // 解析多表格
        const mdTables = parseMarkdownTables(papers_markdown);
        console.log(`解析到 ${mdTables.length} 个表格`);
        
        // 转换为兼容格式
        const tableData = { tables: mdTables };

        const filledDocx = await fillWordDocument(docxBuffer, tableData);

        res.json({
            success: true,
            docx_base64: filledDocx.toString('base64'),
            filename: 'filled_document.docx'
        });

    } catch (error) {
        console.error('处理错误:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// 启动服务器
app.listen(PORT, '127.0.0.1', () => {
    console.log('='.repeat(50));
    console.log('Word文档填表服务已启动');
    console.log(`访问地址: http://127.0.0.1:${PORT}`);
    console.log('='.repeat(50));
});
