# Academic Form Filler for Zotero 7

[![Zotero 7](https://img.shields.io/badge/Zotero-7-green?style=flat-square&logo=zotero&logoColor=CC2936)](https://www.zotero.org)
[![GitHub Repo](https://img.shields.io/badge/GitHub-Xjorker/zotero--academic--form-blue?style=flat-square&logo=github)](https://github.com/Xjorker/zotero-academic-form)
[![License](https://img.shields.io/badge/License-AGPL--3.0-green?style=flat-square)]()

[English](README.md) | [简体中文](doc/README-zhCN.md)

> Upload a DOCX template → AI Agent automatically fills your academic achievements (papers, projects, patents, experience) into the form.

## Features

- **Upload DOCX Template** - Any academic evaluation/award application form
- **AI-Powered Filling** - LLM Agent parses table structure and fills in data intelligently
- **Multi-Source Data** - Pulls data from your Zotero library + local knowledge base + DBLP/CrossRef APIs
- **Knowledge Base** - Stores your personal info, projects, patents, teaching experience
- **Hybrid RAG** - BM25 + vector similarity + reciprocal rank fusion for accurate retrieval
- **Automatic Deduplication** - Prevents duplicate entries when re-filling
- **Zotero Native** - Fully integrated as a Zotero 7 plugin

## Screenshots

> *(TODO: Add screenshots here)*

## Installation

### Method 1: Direct XPI Installation (Recommended for Users)

1. Download the latest `.xpi` from [Releases](https://github.com/Xjorker/zotero-academic-form/releases)
2. Open Zotero 7 → Tools → Plugins → Gear icon → "Install Add-on From File"
3. Select the downloaded `.xpi` file

### Method 2: Build from Source

```bash
git clone https://github.com/Xjorker/zotero-academic-form.git
cd zotero-academic-form
npm install
npm start  # Development mode with hot reload
```

## Prerequisites

- **Zotero 7 Beta** ([Download](https://www.zotero.org/support/beta_builds))
- **Python 3.12+** (for the backend server)
- **Local LLM API** (configured in the plugin settings)

## Backend Setup

The plugin requires a local FastAPI backend running on your machine:

```bash
cd server/word_fill_app
pip install -r requirements.txt
python main.py
```

The backend runs on `http://localhost:8000` by default.

## Usage

1. **Configure Settings** → Enter your LLM API key and backend URL
2. **Prepare your Knowledge Base** → Import your CV, papers, projects via the plugin UI
3. **Upload a DOCX Template** → Click "Fill Academic Form" and select your template
4. **Review & Export** → AI fills the form; review and export as DOCX

## Architecture

```
User's Zotero + Local KB
         │
         ▼
┌─────────────────────┐     ┌──────────────────────┐
│  Zotero 7 Plugin   │────▶│  FastAPI Backend     │
│  (TypeScript)      │     │  (Python)             │
│                    │     │  ┌──────────────────┐ │
│  · wordProcessor   │     │  │ LangGraph Agent  │ │
│  · academicForm   │     │  │  ├ parse_docx     │ │
│  · authorProfile  │     │  │  ├ query_kb       │ │
└─────────────────────┘     │  ├ hybrid_rag      │ │
                             │  ├ fetch_academic │ │
                             │  └ fill_docx      │ │
                             └──────────────────┘ │
                                 └──────────────────────┘
                                           │
                    ┌──────────────────────┼──────────────────────┐
                    ▼                      ▼                      ▼
             ┌────────────┐         ┌────────────┐         ┌────────────┐
             │ ChromaDB   │         │ SQLite KB  │         │ DBLP/CrossRef│
             │ (Vectors)  │         │(Structured)│         │ (Academic APIs)│
             └────────────┘         └────────────┘         └────────────┘
```

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Plugin Framework | [zotero-plugin-template](https://github.com/windingwind/zotero-plugin-template) |
| Frontend | TypeScript + Zotero Plugin Toolkit |
| Backend | Python FastAPI + LangGraph |
| Agent | StateGraph with 6 tools (parse, query, RAG, API, fill) |
| Vector DB | ChromaDB |
| Knowledge Base | SQLite |
| Academic APIs | DBLP, CrossRef |

## Development

```bash
# Install dependencies
npm install

# Start development (requires Zotero 7 Beta)
npm start

# Build production XPI
npm run build

# Release new version (bumps version, git tag, GitHub Action auto-builds)
npm run release
```

## License

AGPL-3.0-or-later

## Acknowledgments

- [zotero-plugin-template](https://github.com/windingwind/zotero-plugin-template) - Plugin scaffolding
- [zotero-plugin-toolkit](https://github.com/windingwind/zotero-plugin-toolkit) - UI/API toolkit
- [LangGraph](https://github.com/langchain-ai/langgraph) - Agent orchestration
