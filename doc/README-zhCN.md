# Academic Form Filler for Zotero 7

[![Zotero 7](https://img.shields.io/badge/Zotero-7-green?style=flat-square&logo=zotero&logoColor=CC2936)](https://www.zotero.org)
[![GitHub Repo](https://img.shields.io/badge/GitHub-Xjorker/zotero--academic--form-blue?style=flat-square&logo=github)](https://github.com/Xjorker/zotero-academic-form)
[![License](https://img.shields.io/badge/License-AGPL--3.0-green?style=flat-square)]()

> 上传 DOCX 模板 → AI Agent 自动将您的学术成果（论文、项目、专利、经历）填入表单。

[English](README.md) | 简体中文

## 功能特性

- **上传 DOCX 模板** - 支持任意学术评审/奖项申报表格
- **AI 智能填表** - LLM Agent 解析表格结构，智能填充数据
- **多源数据融合** - 从 Zotero 文献库 + 本地知识库 + DBLP/CrossRef API 获取数据
- **本地知识库** - 存储个人信息、科研项目、专利、教学经历
- **混合 RAG 检索** - BM25 + 向量相似度 + 互惠排名融合（RRF），精准检索
- **自动去重** - 重新填表时自动排除重复条目
- **Zotero 原生集成** - 完全融入 Zotero 7 作为插件运行

## 截图

> *(TODO: 在此添加截图)*

## 安装

### 方式一：直接安装 XPI（推荐用户）

1. 从 [Releases](https://github.com/Xjorker/zotero-academic-form/releases) 下载最新的 `.xpi` 文件
2. 打开 Zotero 7 → 工具 → 插件 → ⚙️ 图标 → "从文件安装插件"
3. 选择下载的 `.xpi` 文件

### 方式二：从源码构建

```bash
git clone https://github.com/Xjorker/zotero-academic-form.git
cd zotero-academic-form
npm install
npm start  # 开发模式，支持热重载
```

## 前置依赖

- **Zotero 7 Beta** ([下载](https://www.zotero.org/support/beta_builds))
- **Python 3.12+**（用于运行后端服务）
- **本地 LLM API**（在插件设置中配置）

## 后端配置

插件需要在本地运行一个 FastAPI 后端服务：

```bash
cd server/word_fill_app
pip install -r requirements.txt
python main.py
```

后端默认运行在 `http://localhost:8000`。

## 使用方法

1. **配置设置** → 输入 LLM API Key 和后端地址
2. **构建知识库** → 通过插件界面导入个人简历、论文、项目信息
3. **上传 DOCX 模板** → 点击"填写学术表单"并选择模板文件
4. **审核并导出** → AI 自动填表，审核后导出 DOCX

## 架构图

```
用户 Zotero + 本地知识库
         │
         ▼
┌─────────────────────┐     ┌──────────────────────┐
│  Zotero 7 插件      │────▶│  FastAPI 后端         │
│  (TypeScript)      │     │  (Python)              │
│                    │     │  ┌──────────────────┐ │
│  · wordProcessor   │     │  │ LangGraph Agent   │ │
│  · academicForm   │     │  │  ├ parse_docx     │ │
│  · authorProfile   │     │  │  ├ query_kb       │ │
└─────────────────────┘     │  ├ hybrid_rag       │ │
                             │  ├ fetch_academic  │ │
                             │  └ fill_docx       │ │
                             └──────────────────┘ │
                                 └──────────────────────┘
                                           │
                    ┌──────────────────────┼──────────────────────┐
                    ▼                      ▼                      ▼
             ┌────────────┐         ┌────────────┐         ┌────────────┐
             │ ChromaDB   │         │ SQLite 知识库│        │ DBLP/CrossRef│
             │ (向量库)    │         │ (结构化数据)│         │ (学术API)   │
             └────────────┘         └────────────┘         └────────────┘
```

## 技术栈

| 层级 | 技术 |
|------|------|
| 插件框架 | [zotero-plugin-template](https://github.com/windingwind/zotero-plugin-template) |
| 前端 | TypeScript + Zotero Plugin Toolkit |
| 后端 | Python FastAPI + LangGraph |
| Agent | StateGraph，6 个工具（解析、查询、RAG、API、填充） |
| 向量数据库 | ChromaDB |
| 知识库 | SQLite |
| 学术 API | DBLP, CrossRef |

## 开发

```bash
# 安装依赖
npm install

# 启动开发（需要 Zotero 7 Beta）
npm start

# 构建生产环境 XPI
npm run build

# 发布新版本（自动递增版本号、git tag，GitHub Action 自动构建）
npm run release
```

## 开源协议

AGPL-3.0-or-later

## 致谢

- [zotero-plugin-template](https://github.com/windingwind/zotero-plugin-template) - 插件脚手架
- [zotero-plugin-toolkit](https://github.com/windingwind/zotero-plugin-toolkit) - UI/API 工具包
- [LangGraph](https://github.com/langchain-ai/langgraph) - Agent 编排框架
