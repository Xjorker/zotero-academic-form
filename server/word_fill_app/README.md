# Word文档填表服务

FastAPI服务，用于将markdown格式的表格数据填充到Word文档中。

## 功能

- 接收docx文件和papers_markdown数据
- 解析Word文档（ZIP格式）
- 修改word/document.xml填充表格数据
- 重新打包为docx返回

## 部署

### 1. 安装依赖

```bash
cd server/word_fill_app
pip install -r requirements.txt
```

### 2. 启动服务

```bash
# 开发模式
uvicorn main:app --host 0.0.0.0 --port 8000 --reload

# 生产模式
uvicorn main:app --host 0.0.0.0 --port 8000 --workers 4
```

### 3. Docker部署

创建 Dockerfile:

```dockerfile
FROM python:3.10-slim
WORKDIR /app
COPY requirements.txt .
RUN pip install -r requirements.txt
COPY . .
EXPOSE 8000
CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8000"]
```

构建运行:
```bash
docker build -t word-fill-service .
docker run -d -p 8000:8000 word-fill-service
```

## API接口

### 1. 文件上传方式

```bash
POST /fill
Content-Type: multipart/form-data

参数:
- file: Word文档(.docx)
- papers_markdown: markdown格式的表格数据
```

### 2. Base64方式

```bash
POST /fill_base64
Content-Type: application/x-www-form-urlencoded

参数:
- docx_base64: Word文档的base64编码
- papers_markdown: markdown格式的表格数据
```

## 测试示例

```bash
# 测试服务
curl -X GET http://localhost:8000/

# 测试填表功能
curl -X POST http://localhost:8000/fill \
  -F "file=@template.docx" \
  -F "papers_markdown=| 标题 | 年份 |
|------|------|
| 项目1 | 2024 |
| 项目2 | 2023 |"
```

## Zotero插件调用示例

在academicForm.ts中修改调用方式：

```typescript
// 调用服务器端的填表服务
const fillUrl = "http://your-server:8000/fill_base64";

const formData = new FormData();
formData.append("docx_base64", docxBase64);
formData.append("papers_markdown", papersMarkdown);

const response = await fetch(fillUrl, {
    method: "POST",
    body: formData
});

const result = await response.json();
if (result.success) {
    const filledDocxBase64 = result.docx_base64;
    // 保存文件...
}
```

## 注意事项

1. Word文档本质是ZIP文件，需要正确处理XML命名空间
2. 表格填充逻辑需要根据实际模板结构调整
3. 建议添加认证机制防止滥用
4. 大文件处理可能需要调整超时设置
