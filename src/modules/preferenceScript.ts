import { config } from "../../package.json";
import { getPref, setPref, CustomField } from "../utils/prefs";
import { saveAuthor, saveProjects_sql, savePatents_sql, saveDatasets_sql } from "./database";
import { getDefaultModel } from "./llmService";
const { Services } = ChromeUtils.import("resource://gre/modules/Services.jsm");

// ========== 模块级辅助函数：XUL menulist 操作（供所有事件处理器使用）==========
// menulist 的 menupopup 中包含 menuitem，每个 menuitem 有 label 和 value 属性

/** 获取 XUL menulist 的当前选中值 */
export function getMenulistValue(ml: any): string {
  if (!ml) return '';
  try {
    const selected = ml.selectedItem;
    if (selected) {
      return (selected.getAttribute('value') || '').trim();
    }
    return (ml.getAttribute('value') || '').trim();
  } catch(e) {
    return '';
  }
}

/** 设置 XUL menulist 的当前选中值 */
export function setMenulistValue(ml: any, val: string) {
  if (!ml) return;
  try {
    ml.setAttribute('value', val);
    const popup = ml.querySelector('menupopup');
    if (popup) {
      for (const item of popup.children) {
        if ((item.getAttribute('value') || '') === val) {
          ml.selectedItem = item;
          break;
        }
      }
    }
  } catch(e) {}
}

/** 清空 XUL menulist 的所有选项 */
export function clearMenulistPopup(ml: any) {
  if (!ml) return;
  try {
    const popup = ml.querySelector('menupopup');
    if (popup) {
      while (popup.firstChild) {
        popup.removeChild(popup.firstChild);
      }
    }
  } catch(e) {}
}

/** 向 XUL menulist 添加一个菜单项 */
export function addMenuItemToMenulist(ml: any, label: string, value: string, insertBeforeLast?: boolean) {
  if (!ml) return null;
  try {
    const doc = ml.ownerDocument;
    const popup = ml.querySelector('menupopup');
    if (!popup) return null;
    
    const item = doc.createXULElement('menuitem');
    item.setAttribute('label', label);
    item.setAttribute('value', value);
    
    if (insertBeforeLast && popup.lastChild) {
      popup.insertBefore(item, popup.lastChild);
    } else {
      popup.appendChild(item);
    }
    return item;
  } catch(e) {
    return null;
  }
}

/** 为 XUL menulist 绑定"手动输入"选项的 command 事件 */
export function attachModelSelectChangeListener(ml: any) {
  ml.addEventListener('command', () => {
    const selVal = getMenulistValue(ml);
    if (selVal === '__manual_input__') {
      const customModel = window.prompt('请输入模型名称（例如 gpt-4-turbo、claude-3-opus-20240229）：', '');
      if (customModel && customModel.trim()) {
        let existing = false;
        const popup = ml.querySelector('menupopup');
        if (popup) {
          for (const item of Array.from(popup.children)) {
            if ((item.getAttribute('value') || '') === customModel.trim()) { existing = true; break; }
          }
        }
        if (!existing) {
          addMenuItemToMenulist(ml, `${customModel.trim()} (custom)`, customModel.trim(), true);
        }
        setMenulistValue(ml, customModel.trim());
      } else {
        setMenulistValue(ml, '-- 请先点击 Fetch Models --');
      }
    }
  });
}

// 论文信息接口
export interface Publication {
  title: string;
  year?: string;
  venue?: string;
  doi?: string;
  url?: string;
  type?: string;
}

// 专利信息接口
export interface Patent {
  title: string;
  year?: string;
  office?: string;
  number?: string;
  url?: string;
  type?: string;
}

// 数据集信息接口
export interface Dataset {
  title: string;
  year?: string;
  repo?: string;
  doi?: string;
  url?: string;
  type?: string;
}

// 项目信息接口
export interface Project {
  title: string;
  year?: string;
  funder?: string;
  grantId?: string;
  url?: string;
  type?: string;
}

// 作者信息接口（简化版，用于表单编辑）
export interface AuthorInfo {
  orcid: string;
  name: string;
  affiliation: string;
  country: string;
  keywords: string;
  biography: string;
  website: string;
  customFields: CustomField[];
}

// 存储原始论文数据
let publicationsData: Publication[] = [];
// 存储专利
let patentsData: Patent[] = [];
// 存储数据集
let datasetsData: Dataset[] = [];
// 存储项目
let projectsData: Project[] = [];
// 存储作者信息
let authorInfoData: AuthorInfo | null = null;

export function base64Encode(str: string): string {
  if (!str) return "";
  // Zotero环境下兼容中文的Base64编码
  const unicodeStr = encodeURIComponent(str);
  const byteArr = new TextEncoder().encode(unicodeStr);
  return btoa(String.fromCharCode(...byteArr));
}

export function base64Decode(base64Str: string): string {
  if (!base64Str) return "";
  try {
    const byteArr = new Uint8Array(
      atob(base64Str).split("").map(char => char.charCodeAt(0))
    );
    const unicodeStr = new TextDecoder().decode(byteArr);
    return decodeURIComponent(unicodeStr);
  } catch (e) {
    return base64Str; // 解码失败返回原字符串
  }
}

/**
 * 渲染自定义字段编辑区域
 * @param doc 表单文档对象
 * @param container 挂载容器
 */
function renderCustomFieldsUI(doc: Document, container: HTMLElement) {
  const authorInfo = authorInfoData || ({ customFields: [] } as unknown as AuthorInfo);

  // 自定义字段标题
  const title = doc.createElement("h4");
  title.textContent = "自定义字段";
  title.style.margin = "16px 0 8px";
  title.style.fontSize = "14px";
  title.style.fontWeight = "600";
  container.appendChild(title);

  // 自定义字段容器
  const fieldsContainer = doc.createElement("div");
  fieldsContainer.id = "custom-fields-container";
  fieldsContainer.style.display = "flex";
  fieldsContainer.style.flexDirection = "column";
  fieldsContainer.style.gap = "8px";
  container.appendChild(fieldsContainer);

  // 渲染已有自定义字段
  authorInfo.customFields.forEach((field, index) => {
    addCustomFieldRow(doc, fieldsContainer, field, index);
  });

  // 添加新字段按钮
  const addBtn = doc.createElement("button");
  addBtn.textContent = "+ 添加自定义字段";
  addBtn.style.marginTop = "8px";
  addBtn.style.padding = "4px 12px";
  addBtn.style.border = "1px solid #0b5bd3";
  addBtn.style.borderRadius = "4px";
  addBtn.style.background = "#fff";
  addBtn.style.color = "#0b5bd3";
  addBtn.style.cursor = "pointer";
  addBtn.addEventListener("click", () => {
    addCustomFieldRow(doc, fieldsContainer, { key: "", value: "" }, authorInfo.customFields.length);
    // 更新内存中的自定义字段数组
    authorInfo.customFields.push({ key: "", value: "" });
  });
  container.appendChild(addBtn);
}

/**
 * 添加单个自定义字段行
 * @param doc 表单文档对象
 * @param container 挂载容器
 * @param field 字段数据
 * @param index 索引
 */
function addCustomFieldRow(doc: Document, container: HTMLElement, field: CustomField, index: number) {
  const row = doc.createElement("div");
  row.style.display = "flex";
  row.style.gap = "8px";
  row.style.alignItems = "center";

  // 字段名输入框
  const keyInput = doc.createElement("input");
  keyInput.type = "text";
  keyInput.placeholder = "字段名（如：研究方向）";
  keyInput.value = field.key;
  keyInput.style.flex = "1";
  keyInput.style.padding = "4px 8px";
  keyInput.style.border = "1px solid #ddd";
  keyInput.style.borderRadius = "4px";
  keyInput.addEventListener("input", (e) => {
    if (authorInfoData) {
      authorInfoData.customFields[index].key = (e.target as HTMLInputElement).value;
    }
  });

  // 字段值输入框
  const valueInput = doc.createElement("input");
  valueInput.type = "text";
  valueInput.placeholder = "字段值（如：人工智能）";
  valueInput.value = field.value;
  valueInput.style.flex = "2";
  valueInput.style.padding = "4px 8px";
  valueInput.style.border = "1px solid #ddd";
  valueInput.style.borderRadius = "4px";
  valueInput.addEventListener("input", (e) => {
    if (authorInfoData) {
      authorInfoData.customFields[index].value = (e.target as HTMLInputElement).value;
    }
  });

  // 删除按钮
  const delBtn = doc.createElement("button");
  delBtn.textContent = "删除";
  delBtn.style.padding = "4px 8px";
  delBtn.style.border = "1px solid #dc3545";
  delBtn.style.borderRadius = "4px";
  delBtn.style.background = "#fff";
  delBtn.style.color = "#dc3545";
  delBtn.style.cursor = "pointer";
  delBtn.addEventListener("click", () => {
    container.removeChild(row);
    if (authorInfoData) {
      authorInfoData.customFields.splice(index, 1);
      // 重新渲染行（更新索引）
      container.innerHTML = "";
      authorInfoData.customFields.forEach((f, i) => {
        addCustomFieldRow(doc, container, f, i);
      });
    }
  });

  row.appendChild(keyInput);
  row.appendChild(valueInput);
  row.appendChild(delBtn);
  container.appendChild(row);
}

// 规范化 DOI：去掉前缀并转小写
function normalizeDoi(doi?: string): string {
  return (doi || "")
    .trim()
    .replace(/^https?:\/\/(dx\.)?doi\.org\//i, "")
    .toLowerCase();
}

// 规范化标题：压缩空白并转小写
function normalizeTitle(title?: string): string {
  // 去 HTML、去标点、压缩空白并转小写，提升跨来源（ORCID/DBLP）标题匹配鲁棒性
  return (title || "")
    .replace(/<[^>]+>/g, " ")
    .replace(/[^\w\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

// 标题格式化：统一为“每个单词首字母大写”（尽量保留缩写/数字）
function toTitleCase(title?: string): string {
  const input = (title || "").replace(/\s+/g, " ").trim();
  if (!input) return "";

  const cap = (w: string) => {
    if (!w) return w;
    // 全大写/数字/缩写（如 F3KM、SQL、API）保持原样
    if (/^[A-Z0-9]+$/.test(w) && w.length <= 10) return w;
    // 以数字开头的 token（如 3D）保持原样
    if (/^\d/.test(w)) return w;
    const first = w.charAt(0).toUpperCase();
    const rest = w.slice(1).toLowerCase();
    return first + rest;
  };

  const titleCaseToken = (token: string) => {
    // 拆出前后标点（如 “k-means.”、“(foo)”）
    const m = token.match(/^([^A-Za-z0-9]*)([A-Za-z0-9][A-Za-z0-9\-']*)([^A-Za-z0-9]*)$/);
    if (!m) return token;
    const lead = m[1] || "";
    const core = m[2] || "";
    const tail = m[3] || "";

    // 处理连字符：k-means -> K-Means
    const parts = core.split("-");
    const cored = parts.map(cap).join("-");
    return `${lead}${cored}${tail}`;
  };

  return input
    .split(" ")
    .map((t) => titleCaseToken(t))
    .join(" ");
}

// 构造标题+年份键用于去重
function buildTitleYearKey(pub: Publication): string {
  return `${normalizeTitle(pub.title)}|${(pub.year || "").trim()}`;
}

// 保存论文列表到偏好设置
async function savePublications(publications: Publication[]) {
  // 保存前做一次强制去重/合并，避免来源不同导致的“仅差标点/年份缺失”等重复
  const cleaned = mergePublicationsKeepUnique([], publications).map((p) => ({
    ...p,
    title: toTitleCase(p.title),
  }));
  setPref("publications", JSON.stringify(cleaned));
  publicationsData = cleaned;
}
// 保存专利列表到偏好设置 & SQLite
async function savePatents(items: Patent[]) {
  setPref("patents" as any, JSON.stringify(items) as any);

  try {
    await savePatents_sql(items); // database.ts 中的 savePatents
    Zotero.debug(`[AcademicForm] 专利数据库保存成功 ✅ 共 ${items.length} 条`);
  } catch (e) {
    Zotero.debug("[AcademicForm] 保存专利数据库失败 ❌: " + e);
  }

  patentsData = items;
}

// 保存数据集列表到偏好设置 & SQLite
async function saveDatasets(items: Dataset[]) {
  setPref("datasets" as any, JSON.stringify(items) as any);

  try {
    await saveDatasets_sql(items); // database.ts 中的 saveDatasets
    Zotero.debug(`[AcademicForm] 数据集数据库保存成功 ✅ 共 ${items.length} 条`);
  } catch (e) {
    Zotero.debug("[AcademicForm] 保存数据集数据库失败 ❌: " + e);
  }

  datasetsData = items;
}

// 保存项目列表到偏好设置 & SQLite
async function saveProjects(items: Project[]) {
  setPref("projects" as any, JSON.stringify(items) as any);

  try {
    await saveProjects_sql(items); // database.ts 中的 saveProjects_sql
    Zotero.debug(`[AcademicForm] 项目数据库保存成功 ✅ 共 ${items.length} 条`);
  } catch (e) {
    Zotero.debug("[AcademicForm] 保存项目数据库失败 ❌: " + e);
  }

  projectsData = items;
}

// 保存作者信息到偏好设置 & SQLite
async function saveAuthorInfoToPrefs(info: AuthorInfo) {
  // 先 base64 编码 prefs（保持你现有 prefs 逻辑）
  const encodedInfo: AuthorInfo = {
    ...info,
    orcid: base64Encode(info.orcid),
    name: base64Encode(info.name),
    affiliation: base64Encode(info.affiliation),
    country: base64Encode(info.country),
    keywords: base64Encode(info.keywords),
    biography: base64Encode(info.biography),
    website: base64Encode(info.website),
    customFields: info.customFields.map(field => ({
      key: base64Encode(field.key),
      value: base64Encode(field.value)
    }))
  };
  setPref("authorInfo", JSON.stringify(encodedInfo));

  // 保存到 SQLite（不需要 base64）
  try {
    await saveAuthor(info); // database.ts 中的 saveAuthor
    Zotero.debug("[AcademicForm] 作者数据库保存成功 ✅");
  } catch (e) {
    Zotero.debug("[AcademicForm] 写入作者数据库失败 ❌: " + e);
  }

  authorInfoData = encodedInfo;
}

// 从偏好设置加载论文列表
function loadPublications(): Publication[] {
  try {
    const data = getPref("publications") || "[]";
    const publications = JSON.parse(data) as Publication[];
    publicationsData = publications;
    return publications;
  } catch (e) {
    publicationsData = [];
    return [];
  }
}

function escapeHtml(s: string) {
  return (s || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function buildResumeHtml(payload: {
  author: AuthorInfo;
  publications: Publication[];
  patents: Patent[];
  datasets: Dataset[];
  projects: Project[];
}) {
  const a = payload.author;

  const section = (title: string, inner: string, count?: number) => {
    const badge = typeof count === "number" ? `<span class="badge">${count}</span>` : "";
    const sectionClass = title === "个人简介" ? "section section-bio" : "section";
    return `
      <section class="${sectionClass}">
        <div class="section-head">
          <h2 class="section-title">${escapeHtml(title)} ${badge}</h2>
        </div>
        <div class="section-body">${inner}</div>
      </section>
    `;
  };

  const renderList = (items: Array<{ title: string; meta?: string; link?: string }>) => {
    if (!items.length) return `<div class="empty">暂无</div>`;
    return items
      .map((it) => {
        const title = escapeHtml(it.title);
        const meta = it.meta ? `<div class="item-meta">${escapeHtml(it.meta)}</div>` : "";
        return `<div class="item">
          <div class="item-title">${title}</div>
          ${meta}
        </div>`;
      })
      .join("");
  };

  const pubs = payload.publications.map((p) => {
    const parts = [];
    if (p.venue) parts.push(p.venue);
    if (p.year) parts.push(p.year);
    const meta = parts.length > 0 ? parts.join(", ") : "";
    const link = p.url || (p.doi ? `https://doi.org/${normalizeDoi(p.doi)}` : "");
    return { title: p.title, meta, link };
  });

  const patents = payload.patents.map((p) => {
    const parts = [];
    if (p.office) parts.push(p.office);
    if (p.number) parts.push(`专利号: ${p.number}`);
    if (p.year) parts.push(p.year);
    const meta = parts.length > 0 ? parts.join(", ") : "";
    return { title: p.title, meta, link: p.url || "" };
  });

  const datasets = payload.datasets.map((d) => {
    const parts = [];
    if (d.repo) parts.push(d.repo);
    if (d.year) parts.push(d.year);
    const meta = parts.length > 0 ? parts.join(", ") : "";
    const link = d.url || (d.doi ? `https://doi.org/${normalizeDoi(d.doi)}` : "");
    return { title: d.title, meta, link };
  });

  const projects = payload.projects.map((p) => {
    const parts = [];
    if (p.funder) parts.push(p.funder);
    if (p.grantId) parts.push(`项目号: ${p.grantId}`);
    if (p.year) parts.push(p.year);
    const meta = parts.length > 0 ? parts.join(", ") : "";
    return { title: p.title, meta, link: p.url || "" };
  });

  const header = `
    <div class="header">
      <div>
        <div class="name">${escapeHtml(a.name || "未填写姓名")}</div>
        <div class="sub">
          ${a.affiliation ? `<span>${escapeHtml(a.affiliation)}</span>` : ""}
          ${a.country ? `<span> · ${escapeHtml(a.country)}</span>` : ""}
          ${a.website ? `<span> · <a href="${escapeHtml(a.website)}" target="_blank" rel="noreferrer">${escapeHtml(a.website)}</a></span>` : ""}
        </div>
        ${a.keywords ? `<div class="chips">${a.keywords.split(",").map((k) => `<span class="chip">${escapeHtml(k.trim())}</span>`).join("")}</div>` : ""}
      </div>
    </div>
  `;

  const bio = a.biography
    ? `<div class="bio">${escapeHtml(a.biography)}</div>`
    : `<div class="empty">暂无简介</div>`;

  return `
    <style>
      :root{ --bg:#ffffff; --text:#1f2328; --muted:#6b7280; --border:#e5e7eb; --card:#ffffff; --chip:#f3f4f6; --primary:#0b5bd3;}
      *{ box-sizing: border-box; }
      html, body{ margin:0; padding:0; background:#ffffff !important; color:var(--text); font-family: "Microsoft YaHei", "SimHei", "PingFang SC", "Hiragino Sans GB", system-ui, -apple-system, sans-serif; }
      .page{ padding:18px 20px 20px 20px; max-width: 210mm; margin: 0 auto; background:#ffffff; min-height: 100vh; }
      .header-bio-group{ page-break-inside: avoid; }
      .header{ display:flex; gap:12px; justify-content:space-between; align-items:flex-start; padding-bottom:10px; border-bottom:2px solid #1f2328; background:#ffffff; margin-bottom:14px; }
      .name{ font-size:24px; font-weight:700; letter-spacing:0.3px; color:#1f2328; margin-bottom:4px; }
      .sub{ font-size:11px; color:var(--muted); margin-top:2px; line-height:1.5; }
      .sub a{ color:var(--muted); text-decoration:none; }
      .sub a:hover{ text-decoration:underline; }
      .chips{ margin-top:6px; display:flex; flex-wrap:wrap; gap:4px; }
      .chip{ background:var(--chip); border:1px solid var(--border); padding:2px 6px; border-radius:2px; font-size:10px; color:#374151; }
      .section{ margin-top:14px; background:#ffffff; page-break-inside: avoid; }
      .section-bio{ page-break-after: avoid; margin-top:14px; }
      .header-bio-group .section-bio{ margin-top:14px; }
      .section-head{ display:flex; align-items:center; justify-content:space-between; margin-bottom:8px; padding-bottom:4px; border-bottom:1px solid #1f2328; }
      .section-title{ font-size:13px; font-weight:700; margin:0; display:flex; align-items:center; gap:6px; color:#1f2328; text-transform: uppercase; letter-spacing:0.3px; }
      .badge{ font-size:9px; color:#374151; background:#f3f4f6; border:1px solid var(--border); padding:1px 5px; border-radius:2px; }
      .bio{ font-size:11px; color:#374151; line-height:1.6; white-space:pre-wrap; margin:0; }
      .empty{ font-size:11px; color:var(--muted); font-style:italic; }
      .item{ margin-bottom:8px; page-break-inside: avoid; }
      .item-title{ font-weight:600; font-size:12px; line-height:1.4; color:#1f2328; margin-bottom:2px; }
      .item-meta{ margin-top:1px; font-size:10px; color:var(--muted); line-height:1.4; }
      .item-actions{ margin-top:2px; }
      .item-link{ font-size:10px; color:var(--primary); text-decoration:none; }
      .item-link:hover{ text-decoration:underline; }
      @media print{
        @page {
          size: A4;
          margin: 12mm 12mm 12mm 12mm;
          /* 隐藏页眉页脚 */
          marks: none;
        }
        html, body{ margin:0; padding:0; background:#fff !important; }
        a{ color: #000; text-decoration: none; }
        .page{ padding:0; max-width:100%; margin:0; }
        .header-bio-group{ page-break-inside: avoid !important; page-break-after: avoid !important; }
        .header{ border-bottom:2px solid #000; padding-bottom:8px; margin-bottom:12px; }
        .section{ margin-top:12px; }
        .section-bio{ page-break-after: avoid !important; page-break-before: avoid !important; }
        .section-head{ border-bottom:1px solid #000; margin-bottom:6px; padding-bottom:3px; }
        .item{ margin-bottom:6px; }
        .item-link{ display:none !important; }
        body {
          -webkit-print-color-adjust: exact;
          print-color-adjust: exact;
        }
        /* 确保打印时不显示文件路径 */
        * {
          -webkit-print-color-adjust: exact;
          print-color-adjust: exact;
        }
      }
    </style>
    <div class="page">
      <div class="header-bio-group">
        ${header}
        ${section("个人简介", bio)}
      </div>
      ${section("论文", renderList(pubs), payload.publications.length)}
      ${section("专利", renderList(patents), payload.patents.length)}
      ${section("数据集", renderList(datasets), payload.datasets.length)}
      ${section("项目", renderList(projects), payload.projects.length)}
    </div>
    `;
}

function showResumeDialog(doc: Document) {
  // 优先用表单里的最新值（哪怕用户还没点"保存作者信息"）
  const author = getAuthorInfoFromForm(doc);
  const payload = {
    author,
    publications: publicationsData || [],
    patents: patentsData || [],
    datasets: datasetsData || [],
    projects: projectsData || [],
  };

  const dialog = new ztoolkit.Dialog(1, 1);
  dialog.addCell(
    0,
    0,
    {
      tag: "div",
      namespace: "html",
      id: "zpt-resume-root",
      styles: {
        width: "980px",
        height: "680px",
        background: "#ffffff",
        overflow: "auto",
        position: "relative"
      },
      properties: { innerHTML: `<div style="padding:12px;color:#666;">正在生成简历…</div>` },
    },
    true
  );

  dialog.setDialogData({
    loadCallback: () => {
      try {
        const wdoc = dialog.window.document;
        const root = wdoc.getElementById("zpt-resume-root") as HTMLElement | null;
        if (!root) return;
        root.innerHTML = buildResumeHtml(payload);

        // 延迟执行以确保DOM完全加载
        setTimeout(() => {
          try {
            // 在对话框窗口的 body 上添加按钮样式和按钮
            const body = wdoc.body;
            if (!body) {
              ztoolkit.log("无法找到对话框 body");
              return;
            }

            // 检查样式是否已添加
            let styleEl = wdoc.getElementById("zpt-resume-pdf-btn-style") as HTMLStyleElement | null;
            if (!styleEl) {
              styleEl = wdoc.createElement("style");
              styleEl.id = "zpt-resume-pdf-btn-style";
              styleEl.textContent = `
                #zpt-resume-export-pdf-btn {
                  position: absolute !important;
                  top: 10px !important;
                  right: 20px !important;
                  z-index: 99999 !important;
                  border: 2px solid #0b5bd3 !important;
                  background: #0b5bd3 !important;
                  color: #ffffff !important;
                  padding: 12px 24px !important;
                  border-radius: 6px !important;
                  cursor: pointer !important;
                  font-weight: 700 !important;
                  font-size: 14px !important;
                  font-family: "Microsoft YaHei", "SimHei", "PingFang SC", "Hiragino Sans GB", system-ui, sans-serif !important;
                  box-shadow: 0 4px 12px rgba(11, 91, 211, 0.3) !important;
                  transition: all 0.2s !important;
                  display: flex !important;
                  align-items: center !important;
                  justify-content: center !important;
                  line-height: 1 !important;
                  visibility: visible !important;
                  opacity: 1 !important;
                  margin: 0 !important;
                  vertical-align: middle !important;
                }
                #zpt-resume-export-pdf-btn:hover {
                  background: #0a4fc0 !important;
                  transform: translateY(-2px) !important;
                  box-shadow: 0 6px 16px rgba(11, 91, 211, 0.4) !important;
                }
                #zpt-resume-export-pdf-btn:active {
                  transform: translateY(0) !important;
                }
                @media print {
                  #zpt-resume-export-pdf-btn {
                    display: none !important;
                  }
                }
              `;
              if (wdoc.head) {
                wdoc.head.appendChild(styleEl);
              }
            }

            // 检查按钮是否已存在，如果存在则移除
            const existingBtn = wdoc.getElementById("zpt-resume-export-pdf-btn");
            if (existingBtn) {
              existingBtn.remove();
            }

            // 创建新按钮
            const btn = wdoc.createElement("button");
            btn.id = "zpt-resume-export-pdf-btn";
            btn.textContent = "导出 PDF";
            btn.type = "button";
            body.appendChild(btn);

            // 添加点击事件，阻止默认行为和冒泡
            btn.addEventListener("click", (e) => {
              e.preventDefault();
              e.stopPropagation();
              try {
                ztoolkit.log("开始导出PDF...");
                exportResumePdfSilently(dialog.window, payload.author);
              } catch (err) {
                ztoolkit.log("导出PDF失败:", err);
                ztoolkit.getGlobal("alert")("导出PDF失败: " + (err instanceof Error ? err.message : String(err)));
              }
              return false;
            }, true); // 使用捕获阶段确保事件被处理

            ztoolkit.log("PDF导出按钮已创建并绑定事件");
          } catch (e) {
            ztoolkit.log("创建PDF按钮失败:", e);
          }
        }, 100); // 延迟100ms确保DOM完全加载
      } catch (e) {
        ztoolkit.log("简历窗口渲染失败:", e);
      }
    },
  });

  dialog.open("作者简历", {
    width: 1040,
    height: 760,
    resizable: true,
    centerscreen: true,
    noDialogMode: true,
  });
}

function getDefaultDownloadsDirectory(): any {
  try {
    // Zotero/Firefox 环境下可用
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { Services } = (globalThis as any).ChromeUtils.importESModule(
      "resource://gre/modules/Services.sys.mjs"
    );
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const Ci = (globalThis as any).Components.interfaces;
    return Services.dirsvc.get("DfltDwnld", Ci.nsIFile);
  } catch (e) {
    // fallback
    return ztoolkit.getGlobal("Zotero").getTempDirectory();
  }
}

function buildPdfFilePath(author: AuthorInfo): string {
  const ZoteroGlobal = ztoolkit.getGlobal("Zotero") as any;
  const dir = getDefaultDownloadsDirectory();
  const name = (author.name || "resume").trim() || "resume";
  const safeBase = name.replace(/[\\/:*?"<>|]/g, "_");
  const stamp = new Date()
    .toISOString()
    .replace(/[:]/g, "")
    .replace(/\..+$/, "")
    .replace("T", "_");
  const fileName = `${safeBase}_CV_${stamp}.pdf`;
  const file = dir.clone();
  file.append(fileName);
  return file.path;
}

function exportResumePdfSilently(win: Window, author: AuthorInfo) {
  try {
    // 仅作为推荐的 PDF 保存路径（不再尝试静默写 PDF）
    const suggestedPdfPath = buildPdfFilePath(author);
    ztoolkit.log("推荐的 PDF 文件路径:", suggestedPdfPath);

    // 延迟执行，确保简历 DOM 已准备好
    setTimeout(() => {
      try {
        if (!win || !win.document) {
          throw new Error("窗口未准备好");
        }

        const doc = win.document;
        const root = doc.getElementById("zpt-resume-root");
        if (!root) {
          throw new Error("未找到简历根节点");
        }

        // 获取完整 HTML 内容及样式
        const htmlContent = root.innerHTML;
        const styles = Array.from(doc.querySelectorAll("style"))
          .map((style) => (style as HTMLStyleElement).textContent || "")
          .join("\n");

        const fullHtml = `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escapeHtml(author.name || "Resume")}</title>
  <style>
    ${styles}
  </style>
  <script>
    // 页面加载完成后自动触发打印对话框（只触发一次）
    (function() {
      let hasTriggered = false;
      
      function triggerPrint() {
        if (hasTriggered) return;
        hasTriggered = true;
        
        try {
          if (window.print) {
            window.print();
            ztoolkit.log("已触发打印对话框");
          }
        } catch (e) {
          ztoolkit.log("触发打印失败:", e);
        }
      }
      
      // 只在页面完全加载后触发一次
      if (document.readyState === "complete") {
        setTimeout(triggerPrint, 500);
      } else {
        window.addEventListener("load", function() {
          setTimeout(triggerPrint, 500);
        });
      }
    })();
  </script>
</head>
<body>
  ${htmlContent}
</body>
</html>`;

        // 将 HTML 写入 Zotero 临时目录，并通过系统浏览器打开
        const ZoteroGlobal = ztoolkit.getGlobal("Zotero") as any;
        if (!ZoteroGlobal || !ZoteroGlobal.getTempDirectory) {
          throw new Error("无法获取 Zotero 临时目录");
        }

        const tempDir = ZoteroGlobal.getTempDirectory();
        const name = (author.name || "resume").trim() || "resume";
        const safeBase = name.replace(/[\\/:*?"<>|]/g, "_");
        const stamp = new Date()
          .toISOString()
          .replace(/[:]/g, "")
          .replace(/\..+$/, "")
          .replace("T", "_");

        const htmlFileName = `${safeBase}_CV_${stamp}.html`;
        const pdfFileName = `${safeBase}_CV_${stamp}.pdf`;

        const htmlFile = tempDir.clone();
        htmlFile.append(htmlFileName);

        try {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const Cc = (globalThis as any).Components.classes;
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const Ci = (globalThis as any).Components.interfaces;

          const foStream = Cc["@mozilla.org/network/file-output-stream;1"].createInstance(
            Ci.nsIFileOutputStream
          );
          // 0x02 写入, 0x08 创建, 0x20 截断
          foStream.init(htmlFile, 0x02 | 0x08 | 0x20, 0o644, 0);

          const converter = Cc["@mozilla.org/intl/converter-output-stream;1"].createInstance(
            Ci.nsIConverterOutputStream
          );
          converter.init(foStream, "UTF-8", 0, 0);
          converter.writeString(fullHtml);
          converter.close();

          ztoolkit.log("简历 HTML 已写入临时文件:", htmlFile.path);
        } catch (writeErr) {
          ztoolkit.log("写入 HTML 文件失败:", writeErr);
          throw new Error("无法写入临时 HTML 文件");
        }

        try {
          ZoteroGlobal.launchFile(htmlFile);
          ztoolkit.log("已通过系统默认浏览器打开简历 HTML");
        } catch (launchErr) {
          ztoolkit.log("通过浏览器打开 HTML 失败:", launchErr);
          throw new Error("无法通过浏览器打开简历 HTML 文件");
        }

        new ztoolkit.ProgressWindow(config.addonName)
          .createLine({
            text:
              `已在系统浏览器中打开简历，打印对话框将自动弹出。` +
              `请选择"另存为 PDF"并保存。推荐文件名：${pdfFileName}（建议保存到：${suggestedPdfPath}）`,
            type: "default",
            progress: 100,
          })
          .show();

      } catch (printErr) {
        ztoolkit.log("执行打印失败:", printErr);
        const errorMsg = printErr instanceof Error ? printErr.message : String(printErr);

        // 显示错误提示，并建议手动操作
        new ztoolkit.ProgressWindow(config.addonName)
          .createLine({
            text: `无法在系统浏览器中打开简历：${errorMsg}，请在 Zotero 中按 Ctrl+P 或使用菜单打印当前简历窗口`,
            type: "fail",
            progress: 0,
          })
          .show();

        ztoolkit.getGlobal("alert")(
          `无法在系统浏览器中打开简历。\n\n` +
          `错误信息：${errorMsg}\n\n` +
          `你仍然可以在 Zotero 的简历窗口中手动操作：\n` +
          `1. 点击简历区域确保获得焦点\n` +
          `2. 按 Ctrl+P (Windows) 或 Cmd+P (Mac)\n` +
          `3. 在弹出的打印对话框中选择"另存为PDF"\n` +
          `4. 建议命名为：${suggestedPdfPath}`
        );
      }
    }, 300);

  } catch (e) {
    ztoolkit.log("导出 PDF 失败:", e);
    const errorMsg = e instanceof Error ? e.message : String(e);
    ztoolkit.getGlobal("alert")("导出PDF失败: " + errorMsg);
  }
}



function getSelectedSeedPublications(maxCount = 5): Publication[] {
  // 优先使用（折叠/展开）可见表格的选择作为种子；否则取前 maxCount 篇
  try {
    const tableHelper = getTableState("publications")?.tableHelper;
    const visible = getVisibleRows("publications");
    const selectedTitles: string[] = [];
    if (tableHelper?.treeInstance?.selection) {
      for (let i = 0; i < visible.length; i++) {
        if (tableHelper.treeInstance.selection.isSelected(i)) {
          const t = visible[i]?.title;
          if (t) selectedTitles.push(t);
        }
      }
    }
    const picked: Publication[] = [];
    const seen = new Set<string>();
    for (const t of selectedTitles) {
      const nt = normalizeTitle(t);
      if (!nt || seen.has(nt)) continue;
      seen.add(nt);
      const p = publicationsData.find((x) => normalizeTitle(x.title) === nt);
      if (p) picked.push(p);
      if (picked.length >= maxCount) break;
    }
    if (picked.length > 0) return picked;
  } catch (e) {
    // ignore
  }
  return publicationsData.slice(0, maxCount);
}

async function fetchSemanticScholarPaperIdByTitle(title: string): Promise<string | null> {
  if (!title) return null;
  const url =
    "https://api.semanticscholar.org/graph/v1/paper/search?query=" +
    encodeURIComponent(title) +
    "&limit=1&fields=paperId,title,year,authors,url";
  const resp = await fetch(url, {
    headers: { Accept: "application/json" },
    cache: "no-store"
  });
  if (!resp.ok) return null;
  const json = (await resp.json()) as any;
  const data = json.data || [];
  const p = data[0];
  return p?.paperId || null;
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchJsonWithRetry(url: string, options?: { retries?: number }) {
  const retries = options?.retries ?? 4;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const resp = await fetch(url, {
      headers: { Accept: "application/json" },
      cache: "no-store"
    });
    if (resp.ok) return resp.json();
    // 429/503 做指数退避重试
    if ((resp.status === 429 || resp.status === 503) && attempt < retries) {
      const wait = 600 * Math.pow(2, attempt);
      await sleep(wait);
      continue;
    }
    const text = await resp.text().catch(() => "");
    throw new Error(`HTTP ${resp.status} ${text}`.trim());
  }
  throw new Error("请求失败");
}

async function fetchOpenAlexWorkByTitle(title: string): Promise<any | null> {
  if (!title) return null;
  const url =
    "https://api.openalex.org/works?search=" +
    encodeURIComponent(title) +
    "&per-page=1";
  try {
    const json = (await fetchJsonWithRetry(url, { retries: 3 })) as any;
    return (json.results || [])[0] || null;
  } catch (e) {
    ztoolkit.log("OpenAlex 搜索论文失败:", e);
    return null;
  }
}

async function fetchOpenAlexWorkById(id: string): Promise<any | null> {
  if (!id) return null;
  // id 可能是完整 URL（https://openalex.org/W...），注意 openalex.org 返回 HTML，不是 JSON
  let url = "";
  if (id.startsWith("https://openalex.org/")) {
    const wid = id.split("/").pop();
    url = `https://api.openalex.org/works/${wid}`;
  } else if (id.startsWith("https://api.openalex.org/")) {
    url = id;
  } else if (id.startsWith("http")) {
    // 其他 http 链接不支持作为 OpenAlex work id
    return null;
  } else {
    url = `https://api.openalex.org/works/${id}`;
  }
  try {
    return await fetchJsonWithRetry(url, { retries: 3 });
  } catch (e) {
    ztoolkit.log("OpenAlex 获取论文失败:", e);
    return null;
  }
}

async function fetchOpenAlexSimilarByTitles(titles: string[]) {
  const seedNorm = new Set(titles.map((t) => normalizeTitle(t)));
  const score = new Map<string, { w: any; hits: number }>();

  // 用少量种子减少请求数
  const seeds = titles.slice(0, 2);
  for (const t of seeds) {
    const work = await fetchOpenAlexWorkByTitle(t);
    if (!work) continue;

    // 1) references
    const refs: string[] = (work.referenced_works || []).slice(0, 25);
    for (const rid of refs) {
      const w = await fetchOpenAlexWorkById(rid);
      if (!w) continue;
      const title = (w.display_name || "").trim();
      const nt = normalizeTitle(title);
      if (!nt || seedNorm.has(nt)) continue;
      const cur = score.get(nt);
      if (cur) cur.hits += 1;
      else score.set(nt, { w, hits: 1 });
    }

    // 2) citations：部分 OpenAlex work 不返回 cited_by_api_url（可能因字段裁剪/版本差异）
    // 用 filter=cites:Wxxxx 兜底
    const wid = (work.id || "").toString().split("/").pop();
    const citedUrl = wid
      ? `https://api.openalex.org/works?filter=cites:${wid}&per-page=25`
      : "";
    if (citedUrl) {
      try {
        const cited = (await fetchJsonWithRetry(citedUrl, { retries: 3 })) as any;
        const results = cited.results || [];
        for (const w of results) {
          const title = (w.display_name || "").trim();
          const nt = normalizeTitle(title);
          if (!nt || seedNorm.has(nt)) continue;
          const cur = score.get(nt);
          if (cur) cur.hits += 1;
          else score.set(nt, { w, hits: 1 });
        }
      } catch (e) {
        ztoolkit.log("OpenAlex cites filter 获取失败:", e);
      }
    }
  }

  const ranked = [...score.entries()]
    .map(([k, v]) => ({ key: k, ...v }))
    .sort((a, b) => b.hits - a.hits)
    .slice(0, 25);

  return ranked.map((r) => {
    const w = r.w || {};
    const authors =
      (w.authorships || [])
        .map((a: any) => a.author?.display_name)
        .filter(Boolean) || [];
    return {
      title: w.display_name || "",
      year: w.publication_year ? String(w.publication_year) : "",
      url: w.doi || w.id || "",
      authors: authors.slice(0, 8),
      score: r.hits,
    };
  });
}

async function fetchOpenAlexAuthorshipByTitles(titles: string[]) {
  type OAAuthorship = { author?: { display_name?: string }; institutions?: Array<{ display_name?: string }> };
  const authorCounts = new Map<string, { count: number; inst: Set<string> }>();
  const me = normalizePersonName(authorInfoData?.name || "");

  for (const title of titles) {
    const url =
      "https://api.openalex.org/works?search=" +
      encodeURIComponent(title) +
      "&per-page=1&select=authorships";
    let json: any = null;
    try {
      json = (await fetchJsonWithRetry(url, { retries: 3 })) as any;
    } catch (e) {
      ztoolkit.log("OpenAlex authorship 获取失败:", e);
      continue;
    }
    const work = (json.results || [])[0];
    const authorships: OAAuthorship[] = work?.authorships || [];
    for (const a of authorships) {
      const name = (a.author?.display_name || "").trim();
      if (!name) continue;
      if (me && normalizePersonName(name) === me) continue;
      const key = normalizePersonName(name);
      const cur = authorCounts.get(key) || { count: 0, inst: new Set<string>() };
      cur.count += 1;
      for (const ins of a.institutions || []) {
        const dn = (ins.display_name || "").trim();
        if (dn) cur.inst.add(dn);
      }
      authorCounts.set(key, cur);
    }
  }

  return [...authorCounts.entries()]
    .map(([k, v]) => ({
      name: k,
      // 用更自然的展示：把 normalized name 做 Title Case（不会影响统计 key）
      displayName: toTitleCase(k),
      count: v.count,
      institutions: [...v.inst].slice(0, 3),
    }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 20);
}

async function fetchOpenAlexAuthorshipBySeeds(seeds: Publication[]) {
  const titles = seeds.map((p) => p.title).filter(Boolean);
  // 优先用 DOI 精确命中 OpenAlex；无 DOI 再按标题 search
  const authorCounts = new Map<string, { count: number; inst: Set<string> }>();
  const me = normalizePersonName(authorInfoData?.name || "");

  for (const p of seeds) {
    let work: any = null;
    try {
      const doi = normalizeDoi(p.doi);
      if (doi) {
        const url =
          "https://api.openalex.org/works/https://doi.org/" +
          encodeURIComponent(doi) +
          "?select=authorships";
        work = (await fetchJsonWithRetry(url, { retries: 3 })) as any;
      } else {
        const url =
          "https://api.openalex.org/works?search=" +
          encodeURIComponent(p.title) +
          "&per-page=1&select=authorships";
        const json = (await fetchJsonWithRetry(url, { retries: 3 })) as any;
        work = (json.results || [])[0] || null;
      }
    } catch (e) {
      ztoolkit.log("OpenAlex authorship（seed）获取失败:", e);
      continue;
    }

    const authorships = work?.authorships || [];
    for (const a of authorships) {
      const name = (a.author?.display_name || "").trim();
      if (!name) continue;
      if (me && normalizePersonName(name) === me) continue;
      const key = normalizePersonName(name);
      const cur = authorCounts.get(key) || { count: 0, inst: new Set<string>() };
      cur.count += 1;
      for (const ins of a.institutions || []) {
        const dn = (ins.display_name || "").trim();
        if (dn) cur.inst.add(dn);
      }
      authorCounts.set(key, cur);
    }
  }

  return [...authorCounts.entries()]
    .map(([k, v]) => ({
      name: k,
      displayName: toTitleCase(k),
      count: v.count,
      institutions: [...v.inst].slice(0, 3),
    }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 20);
}

function renderRecommendUI(
  doc: Document,
  root: HTMLElement,
  payload: {
    seedTitles: string[];
    similar: Array<{ title: string; year: string; url: string; authors: string[]; score: number }>;
    coauthors: Array<{ displayName: string; count: number; institutions: string[] }>;
  }
) {
  const seedHtml = payload.seedTitles
    .map((t) => `<div class="seed-item">${escapeHtml(t)}</div>`)
    .join("");

  const similarHtml =
    payload.similar.length === 0
      ? `<div class="empty">未找到相似论文（可尝试先选中一两篇更具体的论文，再点“推荐”）</div>`
      : payload.similar
        .map((p) => {
          const authors = p.authors.slice(0, 5).join(", ");
          const meta = [p.year, authors].filter(Boolean).join(" · ");
          const link = p.url ? `<a class="link" href="${escapeHtml(p.url)}">${escapeHtml(p.title)}</a>` : `<span>${escapeHtml(p.title)}</span>`;
          return `<div class="card">
  <div class="card-title">${link}</div>
  <div class="card-meta">${escapeHtml(meta)}</div>
  <div class="card-badge">相关度 ${p.score}</div>
</div>`;
        })
        .join("");

  const coHtml =
    payload.coauthors.length === 0
      ? `<div class="empty">未找到合作作者（可能 OpenAlex 未命中标题）</div>`
      : payload.coauthors
        .map((a) => {
          const inst = a.institutions.join("；");
          return `<div class="card">
  <div class="card-title">${escapeHtml(a.displayName)}</div>
  <div class="card-meta">共现 ${a.count} 次${inst ? ` · ${escapeHtml(inst)}` : ""}</div>
</div>`;
        })
        .join("");

  const similarCount = payload.similar.length;
  const authorCount = payload.coauthors.length;

  root.innerHTML = `
<style>
  .rec-wrap{font-family: system-ui, -apple-system, Segoe UI, sans-serif; padding: 12px; color:#222;}
  .rec-head{display:flex; align-items:flex-start; justify-content:space-between; gap:12px; margin-bottom:10px;}
  .rec-title{font-size:15px; font-weight:700;}
  .rec-sub{font-size:12px; color:#666; margin-top:2px;}
  .seed{background:#f6f7f9; border:1px solid #e6e6e6; border-radius:10px; padding:10px; margin-bottom:10px;}
  .seed-h{font-weight:700; font-size:12px; color:#444; margin-bottom:6px;}
  .seed-item{font-size:12px; color:#333; padding:2px 0; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;}
  .split{display:grid; grid-template-columns: 1fr 1fr; gap:12px; align-items:stretch;}
  .col{border:1px solid #e6e6e6; background:#fff; border-radius:12px; overflow:hidden; display:flex; flex-direction:column; min-height: 360px;}
  .col-head{display:flex; align-items:center; justify-content:space-between; padding:10px 10px 8px 10px; border-bottom:1px solid #efefef; background:#fafafa;}
  .col-title{font-weight:700; font-size:13px;}
  .col-badge{font-size:11px; color:#555; background:#f0f0f0; border-radius:999px; padding:2px 8px;}
  .col-body{padding:10px; overflow:auto; max-height: 360px;}
  .grid{display:grid; grid-template-columns: 1fr; gap:10px;}
  .card{border:1px solid #e6e6e6; background:#fff; border-radius:12px; padding:10px; position:relative;}
  .card-title{font-weight:700; font-size:13px; line-height:1.25;}
  .card-meta{font-size:12px; color:#666; margin-top:4px; line-height:1.25;}
  .card-badge{position:absolute; top:10px; right:10px; font-size:11px; color:#555; background:#f0f0f0; border-radius:999px; padding:2px 8px;}
  .link{color:#0b5bd3; text-decoration:none;}
  .link:hover{text-decoration:underline;}
  .empty{font-size:12px; color:#666; padding:12px; border:1px dashed #d9d9d9; border-radius:12px; background:#fafafa;}
  @media (max-width: 860px){ .split{grid-template-columns: 1fr;} .col{min-height: 260px;} .col-body{max-height: 260px;} }
</style>
<div class="rec-wrap">
  <div class="rec-head">
    <div>
      <div class="rec-title">推荐相关论文 / 合作网络</div>
    </div>
  </div>
  <div class="seed">
    <div class="seed-h">本次推荐依据（优先使用你在表格中选中的论文；否则取前几篇）</div>
    ${seedHtml}
  </div>
  <div class="split">
    <div class="col">
      <div class="col-head">
        <div class="col-title">相关论文</div>
        <div class="col-badge">${similarCount}</div>
      </div>
      <div class="col-body"><div class="grid">${similarHtml}</div></div>
    </div>
    <div class="col">
      <div class="col-head">
        <div class="col-title">相关作者 / 合作网络</div>
        <div class="col-badge">${authorCount}</div>
      </div>
      <div class="col-body"><div class="grid">${coHtml}</div></div>
    </div>
  </div>
</div>`;
}

function showRecommendDialog() {
  const dialog = new ztoolkit.Dialog(1, 1);
  dialog.addCell(
    0,
    0,
    {
      tag: "div",
      namespace: "html",
      id: "zpt-recommend-root",
      styles: { width: "760px", height: "520px" },
      properties: { innerHTML: `<div style="padding:12px;color:#666;">正在加载推荐…</div>` },
    },
    true
  );

  dialog.setDialogData({
    loadCallback: async () => {
      try {
        const doc = dialog.window.document;
        const root = doc.getElementById("zpt-recommend-root") as HTMLElement | null;
        if (!root) return;

        const seeds = getSelectedSeedPublications(5);
        const seedTitles = seeds.map((p) => p.title).filter(Boolean);
        if (seedTitles.length === 0) {
          root.innerHTML = `<div style="padding:12px;color:#666;">暂无论文可用于推荐，请先通过 ORCID/DBLP 获取或手动添加论文。</div>`;
          return;
        }

        root.innerHTML = `<div style="padding:12px;color:#666;">正在从 OpenAlex 获取数据…</div>`;

        // 相似论文使用 OpenAlex 引用网络（references + cited_by）
        const similar = await fetchOpenAlexSimilarByTitles(seedTitles);
        const coauthors = await fetchOpenAlexAuthorshipBySeeds(seeds.slice(0, 5));

        renderRecommendUI(doc, root, { seedTitles, similar, coauthors });
      } catch (e) {
        ztoolkit.log("推荐窗口加载失败:", e);
      }
    },
  });

  dialog.open("推荐相关论文/作者", { width: 820, height: 620, resizable: true, centerscreen: true, noDialogMode: true });
}

// 从偏好设置加载专利列表
export function loadPatents(): Patent[] {
  try {
    const data = (getPref("patents" as any) as any) || "[]";
    const items = JSON.parse(data) as Patent[];
    patentsData = items;
    return items;
  } catch (e) {
    patentsData = [];
    return [];
  }
}

// 从偏好设置加载数据集列表
export function loadDatasets(): Dataset[] {
  try {
    const data = (getPref("datasets" as any) as any) || "[]";
    const items = JSON.parse(data) as Dataset[];
    datasetsData = items;
    return items;
  } catch (e) {
    datasetsData = [];
    return [];
  }
}

// 从偏好设置加载项目列表
export function loadProjects(): Project[] {
  try {
    const data = (getPref("projects" as any) as any) || "[]";
    const items = JSON.parse(data) as Project[];
    projectsData = items;
    return items;
  } catch (e) {
    projectsData = [];
    return [];
  }
}

// 从偏好设置加载作者信息
function loadAuthorInfo(): AuthorInfo | null {
  try {
    const data = getPref("authorInfo") || "{}";
    const encodedInfo = JSON.parse(data) as AuthorInfo;
    // 解码Base64
    const decodedInfo: AuthorInfo = {
      orcid: base64Decode(encodedInfo.orcid),
      name: base64Decode(encodedInfo.name),
      affiliation: base64Decode(encodedInfo.affiliation),
      country: base64Decode(encodedInfo.country),
      keywords: base64Decode(encodedInfo.keywords),
      biography: base64Decode(encodedInfo.biography),
      website: base64Decode(encodedInfo.website),
      customFields: encodedInfo.customFields?.map(field => ({
        key: base64Decode(field.key),
        value: base64Decode(field.value)
      })) || []
    };
    authorInfoData = decodedInfo;
    return decodedInfo;
  } catch (e) {
    authorInfoData = {
      orcid: "",
      name: "",
      affiliation: "",
      country: "",
      keywords: "",
      biography: "",
      website: "",
      customFields: [] // 初始化空自定义字段
    };
    return authorInfoData;
  }
}

// 根据 DOI 查找已有条目（先 contains 再 is，兼容大小写/前缀）
async function findExistingByDoi(
  ZoteroGlobal: any,
  libraryID: number,
  doiRaw?: string
) {
  const doi = normalizeDoi(doiRaw);
  const candidates = [
    doi, // contains 用规范化
    doiRaw?.trim(), // is 用原值
    doi, // is 用规范化
  ].filter(Boolean) as string[];

  for (let idx = 0; idx < candidates.length; idx++) {
    const value = candidates[idx];
    const mode = idx === 0 ? "contains" : "is";
    const search = new ZoteroGlobal.Search();
    search.libraryID = libraryID;
    search.addCondition("DOI", mode, value);
    const ids = await search.search();
    if (ids.length > 0) {
      return ZoteroGlobal.Items.getAsync(ids[0]);
    }
  }
  return null;
}

// 根据标题+年份查找已有条目（contains 搜索，命中后再规范化比对）
async function findExistingByTitleYear(
  ZoteroGlobal: any,
  libraryID: number,
  title?: string,
  year?: string
) {
  const normTitle = normalizeTitle(title);
  if (!normTitle) return null;

  const search = new ZoteroGlobal.Search();
  search.libraryID = libraryID;
  search.addCondition("title", "contains", title || "");
  if (year) {
    search.addCondition("year", "is", year);
  }

  const ids = await search.search();
  for (const id of ids) {
    const item = await ZoteroGlobal.Items.getAsync(id);
    const itemTitle = normalizeTitle(item.getField("title"));
    const itemYear = (item.getField("year") || "").toString().trim();
    if (itemTitle === normTitle && (!year || itemYear === year.trim())) {
      return item;
    }
  }
  return null;
}

// 通过 ORCID API 获取作者信息
async function fetchAuthorInfoFromOrcid(orcid: string): Promise<AuthorInfo> {
  const cleanOrcid = orcid.replace(/https?:\/\/orcid\.org\//i, "").trim();

  // 获取个人信息
  const personResp = await fetch(
    `https://pub.orcid.org/v3.0/${cleanOrcid}/person`,
    {
      headers: { Accept: "application/json" },
      cache: "no-store",
    }
  );

  if (!personResp.ok) {
    throw new Error(`ORCID API 返回错误: ${personResp.status}`);
  }

  const personData = (await personResp.json()) as any;

  // 解析姓名
  const nameData = personData.name || {};
  const givenName = nameData["given-names"]?.value || "";
  const familyName = nameData["family-name"]?.value || "";
  const creditName = nameData["credit-name"]?.value || "";
  const displayName = creditName || `${givenName} ${familyName}`.trim();

  // 解析传记
  const biography = personData.biography?.content || "";

  // 解析关键词
  const keywords: string[] = [];
  const keywordsData = personData.keywords?.keyword || [];
  for (const kw of keywordsData) {
    if (kw.content) {
      keywords.push(kw.content);
    }
  }

  // 解析国家
  const country = personData.addresses?.address?.[0]?.country?.value || "";

  // 解析网站链接
  let website = "";
  const urlsData = personData["researcher-urls"]?.["researcher-url"] || [];
  if (urlsData.length > 0) {
    website = urlsData[0].url?.value || "";
  }

  // 获取工作/机构信息
  let affiliation = "";
  try {
    const employmentsResp = await fetch(
      `https://pub.orcid.org/v3.0/${cleanOrcid}/employments`,
      {
        headers: { Accept: "application/json" },
        cache: "no-store",
      }
    );

    if (employmentsResp.ok) {
      const employmentsData = (await employmentsResp.json()) as any;
      const affGroups = employmentsData["affiliation-group"] || [];

      const affiliations: string[] = [];
      for (const group of affGroups) {
        const summaries = group.summaries || [group];
        for (const summary of summaries) {
          const emp = summary["employment-summary"] || summary;
          if (emp.organization?.name) {
            let affText = emp.organization.name;
            if (emp["department-name"]) {
              affText += ` - ${emp["department-name"]}`;
            }
            affiliations.push(affText);
          }
        }
      }
      affiliation = affiliations.slice(0, 3).join("; ");
    }
  } catch (e) {
    ztoolkit.log("获取机构信息失败:", e);
  }

  return {
    orcid: cleanOrcid,
    name: displayName,
    affiliation,
    country,
    keywords: keywords.join(", "),
    biography,
    website,
    customFields: [],
  };
}

// 通过 ORCID works 获取各类作品（论文/专利/数据集/项目）
// 注：当前“获取信息”按钮仅使用论文获取；其余分类暂不从 ORCID 拉取（由用户手动维护）。
async function fetchWorksFromOrcid(orcid: string): Promise<{
  publications: Publication[];
  patents: Patent[];
  datasets: Dataset[];
  projects: Project[];
}> {
  if (!orcid) {
    return { publications: [], patents: [], datasets: [], projects: [] };
  }

  const cleanOrcid = orcid.replace(/https?:\/\/orcid\.org\//i, "").trim();
  const url = `https://pub.orcid.org/v3.0/${cleanOrcid}/works`;

  const publications: Publication[] = [];
  const patents: Patent[] = [];
  const datasets: Dataset[] = [];
  const projects: Project[] = [];

  try {
    const resp = await fetch(url, {
      headers: {
        Accept: "application/json",
      },
      cache: "no-store",
    });

    if (!resp.ok) {
      throw new Error(`ORCID API 返回错误: ${resp.status}`);
    }

    const data = (await resp.json()) as any;
    const groups = data.group || [];

    for (const group of groups) {
      const workSummary = group["work-summary"]?.[0];
      if (!workSummary) continue;

      const title = workSummary.title?.title?.value || "未知标题";
      const year = workSummary["publication-date"]?.year?.value;
      const venue = workSummary["journal-title"]?.value || "";
      const typeRaw = (workSummary.type || "").toString().toLowerCase();

      let doi = "";
      let patentNumber = "";
      const externalIds = workSummary["external-ids"]?.["external-id"] || [];
      for (const eid of externalIds) {
        const idType = (eid["external-id-type"] || "").toString().toLowerCase();
        if (idType === "doi") {
          doi = normalizeDoi(eid["external-id-value"]);
        }
        if (idType === "patent" || idType === "patent-number") {
          patentNumber = eid["external-id-value"] || "";
        }
      }

      const baseUrl = workSummary.url?.value || (doi ? `https://doi.org/${doi}` : "");

      // 按类型拆分
      if (typeRaw === "patent") {
        patents.push({
          title,
          year,
          office: venue || workSummary?.source?.sourceName?.value || "",
          number: patentNumber || doi,
          url: baseUrl,
          type: workSummary.type,
        });
        continue;
      }

      if (typeRaw === "data-set" || typeRaw === "dataset") {
        datasets.push({
          title,
          year,
          repo: venue || workSummary?.source?.sourceName?.value || "",
          doi,
          url: baseUrl,
          type: workSummary.type,
        });
        continue;
      }

      if (typeRaw === "grant" || typeRaw === "project") {
        projects.push({
          title,
          year,
          funder: venue || workSummary?.source?.sourceName?.value || "",
          grantId: patentNumber || doi,
          url: baseUrl,
          type: workSummary.type,
        });
        continue;
      }

      // 默认归类为论文/出版物
      publications.push({
        title,
        year,
        venue,
        doi,
        url: baseUrl,
        type: workSummary.type || "unknown",
      });
    }
  } catch (e) {
    ztoolkit.log("ORCID 获取作品失败:", e);
    throw e;
  }

  return { publications, patents, datasets, projects };
}

// 通过 ORCID API 获取论文
async function fetchPublicationsFromOrcid(
  orcid: string
): Promise<Publication[]> {
  // 仅抓取 works 中的论文（避免额外拉取 fundings/datacite 等）
  const works = await fetchWorksFromOrcid(orcid);
  return works.publications;
}

// 通过 ORCID funding 获取项目/资助
async function fetchProjectsFromOrcidFunding(orcid: string): Promise<Project[]> {
  if (!orcid) return [];
  const cleanOrcid = orcid.replace(/https?:\/\/orcid\.org\//i, "").trim();
  const url = `https://pub.orcid.org/v3.0/${cleanOrcid}/fundings`;
  const projects: Project[] = [];

  const resp = await fetch(url, {
    headers: { Accept: "application/json" },
    cache: "no-store"
  });
  if (!resp.ok) return projects;

  const data = (await resp.json()) as any;
  const groups = data["group"] || [];
  for (const g of groups) {
    const summary = g["funding-summary"]?.[0];
    if (!summary) continue;
    const title =
      summary["title"]?.["title"]?.value ||
      summary["title"]?.["translated-title"]?.value ||
      "未命名项目";
    const startYear = summary["start-date"]?.year?.value;
    const endYear = summary["end-date"]?.year?.value;
    const year = startYear || endYear;
    const funder = summary["organization"]?.name || "";
    let grantId = "";
    const extIds = summary["external-ids"]?.["external-id"] || [];
    for (const id of extIds) {
      const t = (id["external-id-type"] || "").toString().toLowerCase();
      if (t === "grant_number" || t === "grant-number" || t === "grant") {
        grantId = id["external-id-value"] || "";
        break;
      }
    }
    const urlField = summary["url"]?.value || "";
    projects.push({
      title,
      year: year || "",
      funder,
      grantId,
      url: urlField,
      type: "grant",
    });
  }
  return projects;
}

// 从 DataCite 通过 ORCID 查询数据集
async function fetchDatasetsFromDataCite(orcid: string): Promise<Dataset[]> {
  if (!orcid) return [];
  const cleanOrcid = orcid.replace(/https?:\/\/orcid\.org\//i, "").trim();
  const datasets: Dataset[] = [];

  // DataCite 支持 filter=creators.orcid:<orcid>，一次拉取前 100 条
  const url = `https://api.datacite.org/works?filter=creators.orcid:${encodeURIComponent(
    cleanOrcid
  )}&page[size]=100&resource-type-id=dataset`;
  const resp = await fetch(url, {
    headers: { Accept: "application/json" },
    cache: "no-store"
  });
  if (!resp.ok) return datasets;

  const json = (await resp.json()) as any;
  const items = json.data || [];
  for (const it of items) {
    const attr = it.attributes || {};
    const titles = attr.titles || [];
    const title = titles[0]?.title || "未命名数据集";
    const year = attr.publicationYear?.toString() || "";
    const doi = normalizeDoi(attr.doi || "");
    const urlField = attr.url || (doi ? `https://doi.org/${doi}` : "");
    const repo =
      attr.publisher ||
      (attr.container?.title ? attr.container.title : attr.clientId) ||
      "DataCite";
    datasets.push({
      title,
      year,
      repo,
      doi,
      url: urlField,
      type: "dataset",
    });
  }
  return datasets;
}

// ---------------------------
// 外部插件接口：检查并调用外部插件功能
// ---------------------------

/**
 * 外部插件接口命名空间
 * 外部插件应该将功能挂载到 Zotero.MyPublicationsExtensions 下
 */
interface ExternalPluginExtensions {
  patent?: {
    queryByORCID?: (orcid: string) => Promise<Patent[]>;
    queryByPatentNumber?: (patentNumber: string, office?: string) => Promise<Patent | null>;
  };
  dataset?: {
    queryByORCID?: (orcid: string) => Promise<Dataset[]>;
    queryByDOI?: (doi: string) => Promise<Dataset | null>;
  };
  project?: {
    queryByORCID?: (orcid: string) => Promise<Project[]>;
    queryByGrantId?: (grantId: string) => Promise<Project | null>;
  };
}

// 检查外部插件是否已安装并可用
function checkExternalPluginAvailable(pluginType: "patent" | "dataset" | "project"): boolean {
  try {
    const extensions = (Zotero as any).MyPublicationsExtensions as ExternalPluginExtensions | undefined;
    if (!extensions) return false;

    switch (pluginType) {
      case "patent":
        return typeof extensions.patent?.queryByORCID === "function";
      case "dataset":
        return typeof extensions.dataset?.queryByORCID === "function";
      case "project":
        return typeof extensions.project?.queryByORCID === "function";
      default:
        return false;
    }
  } catch (e) {
    ztoolkit.log(`检查外部插件 ${pluginType} 失败:`, e);
    return false;
  }
}

// 从外部插件获取专利数据
async function fetchPatentsFromExternalPlugin(orcid: string): Promise<Patent[]> {
  try {
    const extensions = (Zotero as any).MyPublicationsExtensions as ExternalPluginExtensions | undefined;
    if (!extensions?.patent?.queryByORCID) {
      return [];
    }

    ztoolkit.log("调用外部专利查询插件");
    const patents = await extensions.patent.queryByORCID(orcid);

    // 验证返回数据格式
    if (!Array.isArray(patents)) {
      throw new Error("外部插件返回的专利数据格式不正确，应为数组");
    }

    // 确保数据符合 Patent 接口
    return patents.map((p: any) => ({
      title: p.title || "",
      year: p.year || "",
      office: p.office || "",
      number: p.number || "",
      url: p.url || "",
      type: p.type || "patent",
    }));
  } catch (e) {
    ztoolkit.log("从外部插件获取专利失败:", e);
    throw e;
  }
}

// 从外部插件获取数据集数据
async function fetchDatasetsFromExternalPlugin(orcid: string): Promise<Dataset[]> {
  try {
    const extensions = (Zotero as any).MyPublicationsExtensions as ExternalPluginExtensions | undefined;
    if (!extensions?.dataset?.queryByORCID) {
      return [];
    }

    ztoolkit.log("调用外部数据集查询插件");
    const datasets = await extensions.dataset.queryByORCID(orcid);

    if (!Array.isArray(datasets)) {
      throw new Error("外部插件返回的数据集数据格式不正确，应为数组");
    }

    return datasets.map((d: any) => ({
      title: d.title || "",
      year: d.year || "",
      repo: d.repo || "",
      doi: d.doi || "",
      url: d.url || "",
      type: d.type || "dataset",
    }));
  } catch (e) {
    ztoolkit.log("从外部插件获取数据集失败:", e);
    throw e;
  }
}

// 从外部插件获取项目数据
async function fetchProjectsFromExternalPlugin(orcid: string): Promise<Project[]> {
  try {
    const extensions = (Zotero as any).MyPublicationsExtensions as ExternalPluginExtensions | undefined;
    if (!extensions?.project?.queryByORCID) {
      return [];
    }

    ztoolkit.log("调用外部项目查询插件");
    const projects = await extensions.project.queryByORCID(orcid);

    if (!Array.isArray(projects)) {
      throw new Error("外部插件返回的项目数据格式不正确，应为数组");
    }

    return projects.map((p: any) => ({
      title: p.title || "",
      year: p.year || "",
      funder: p.funder || "",
      grantId: p.grantId || "",
      url: p.url || "",
      type: p.type || "grant",
    }));
  } catch (e) {
    ztoolkit.log("从外部插件获取项目失败:", e);
    throw e;
  }
}

// 合并外部插件数据和本地数据
function mergePatents(local: Patent[], external: Patent[]): Patent[] {
  const merged = [...local];
  const seen = new Set<string>();

  // 标记本地已有的专利（按标题+年份去重）
  local.forEach((p) => {
    const key = `${normalizeTitle(p.title)}|${p.year || ""}`;
    seen.add(key);
  });

  // 添加外部插件的新专利
  external.forEach((p) => {
    const key = `${normalizeTitle(p.title)}|${p.year || ""}`;
    if (!seen.has(key)) {
      merged.push(p);
      seen.add(key);
    }
  });

  return merged;
}

function mergeDatasets(local: Dataset[], external: Dataset[]): Dataset[] {
  const merged = [...local];
  const seen = new Set<string>();

  local.forEach((d) => {
    const key = d.doi ? normalizeDoi(d.doi) : `${normalizeTitle(d.title)}|${d.year || ""}`;
    seen.add(key);
  });

  external.forEach((d) => {
    const key = d.doi ? normalizeDoi(d.doi) : `${normalizeTitle(d.title)}|${d.year || ""}`;
    if (!seen.has(key)) {
      merged.push(d);
      seen.add(key);
    }
  });

  return merged;
}

function mergeProjects(local: Project[], external: Project[]): Project[] {
  const merged = [...local];
  const seen = new Set<string>();

  local.forEach((p) => {
    const key = p.grantId || `${normalizeTitle(p.title)}|${p.year || ""}`;
    seen.add(key);
  });

  external.forEach((p) => {
    const key = p.grantId || `${normalizeTitle(p.title)}|${p.year || ""}`;
    if (!seen.has(key)) {
      merged.push(p);
      seen.add(key);
    }
  });

  return merged;
}

// ---------------------------
// DBLP 补充论文（基于作者姓名 + 与 ORCID 论文重合度确认）
// ---------------------------
function extractDoiFromEe(ee?: string): string {
  if (!ee) return "";
  const s = ee.trim();
  if (/doi\.org\//i.test(s)) {
    return normalizeDoi(s.split(/doi\.org\//i)[1]);
  }
  if (s.startsWith("10.")) return normalizeDoi(s);
  return "";
}

function normalizePersonName(name: string): string {
  // 用于 ORCID 姓名与 DBLP 候选名的严格匹配：忽略大小写/标点/多空格，并去掉 DBLP 尾部编号
  return (name || "")
    .trim()
    .replace(/\s+\d{3,4}$/, "") // DBLP 常见尾部编号：0001/0007 等
    .toLowerCase()
    .replace(/[^\w\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

async function searchDblpAuthorsByName(name: string): Promise<
  Array<{ name: string; url: string; pid: string }>
> {
  if (!name) return [];
  try {
    // h 控制候选数量，这里尽量拉多一点（DBLP 会有上限）
    const url = `https://dblp.org/search/author/api?q=${encodeURIComponent(
      name
    )}&format=json&h=200`;
    const resp = await fetch(url, {
      headers: { Accept: "application/json" },
      cache: "no-store"
    });
    if (!resp.ok) return [];
    const json = (await resp.json()) as any;
    const hits = json.result?.hits?.hit || [];
    const out: Array<{ name: string; url: string; pid: string }> = [];
    for (const hit of hits) {
      const info = hit.info || {};
      const authorName = info.author || "";
      const authorUrl = info.url || "";
      const pid =
        info.pid ||
        (authorUrl && authorUrl.includes("/pid/")
          ? authorUrl.split("/pid/")[1].replace(/\/$/, "")
          : "");
      if (authorName && pid) {
        out.push({ name: authorName, url: authorUrl, pid });
      }
    }
    return out;
  } catch (e) {
    ztoolkit.log("DBLP 作者搜索失败:", e);
    return [];
  }
}

async function fetchDblpAuthorPublications(
  pid: string,
  options?: { limit?: number }
): Promise<Publication[]> {
  if (!pid) return [];
  try {
    const url = `https://dblp.org/pid/${pid}.xml`;
    const resp = await fetch(url, { cache: "no-store" });
    if (!resp.ok) return [];
    const text = await resp.text();

    const blocks = [
      ...(text.match(/<article[^>]*>[\s\S]*?<\/article>/g) || []),
      ...(text.match(/<inproceedings[^>]*>[\s\S]*?<\/inproceedings>/g) || []),
      ...(text.match(/<proceedings[^>]*>[\s\S]*?<\/proceedings>/g) || []),
    ];

    const pubs: Publication[] = [];
    const limit = options?.limit;
    for (let idx = 0; idx < blocks.length; idx++) {
      const b = blocks[idx];
      const titleMatch = b.match(/<title>([\s\S]*?)<\/title>/);
      const yearMatch = b.match(/<year>(\d+)<\/year>/);
      const eeMatch = b.match(/<ee>([\s\S]*?)<\/ee>/);
      const journalMatch = b.match(/<journal>([\s\S]*?)<\/journal>/);
      const booktitleMatch = b.match(/<booktitle>([\s\S]*?)<\/booktitle>/);

      const titleRaw = titleMatch ? titleMatch[1] : "";
      const title = titleRaw.replace(/<[^>]+>/g, "").trim();
      if (!title) continue;

      const year = yearMatch ? yearMatch[1] : "";
      const venue = (journalMatch?.[1] || booktitleMatch?.[1] || "")
        .replace(/<[^>]+>/g, "")
        .trim();
      const ee = eeMatch ? eeMatch[1].trim() : "";
      const doi = extractDoiFromEe(ee);

      pubs.push({
        title,
        year,
        venue,
        doi: doi || undefined,
        url: ee || "",
        type: "dblp",
      });

      if (limit && pubs.length >= limit) {
        break;
      }
    }

    return pubs;
  } catch (e) {
    ztoolkit.log("DBLP 获取作者论文失败:", e);
    return [];
  }
}

async function inferDblpPidFromPublicationSearch(
  authorName: string
): Promise<string | null> {
  const q = authorName?.trim();
  if (!q) return null;

  try {
    const url = `https://dblp.org/search/publ/api?q=${encodeURIComponent(
      q
    )}&format=json&h=30`;
    const resp = await fetch(url, {
      headers: { Accept: "application/json" },
      cache: "no-store"
    });
    if (!resp.ok) return null;
    const json = (await resp.json()) as any;
    const hits = json.result?.hits?.hit || [];

    const target = normalizePersonName(authorName);
    const pidCount = new Map<string, number>();

    for (const h of hits) {
      const info = h.info || {};
      const authorsData = info.authors?.author || [];
      const authorsList = Array.isArray(authorsData) ? authorsData : [authorsData];
      for (const a of authorsList) {
        if (typeof a !== "object") continue;
        const name = a.text || a["#text"] || "";
        const pid = a["@pid"] || "";
        if (!name || !pid) continue;
        if (normalizePersonName(name) === target) {
          pidCount.set(pid, (pidCount.get(pid) || 0) + 1);
        }
      }
    }

    // 选择出现次数最多的 pid，且至少命中 2 次才认为可靠
    let bestPid = "";
    let bestCount = 0;
    for (const [pid, count] of pidCount.entries()) {
      if (count > bestCount) {
        bestPid = pid;
        bestCount = count;
      }
    }
    if (bestPid && bestCount >= 2) return bestPid;
  } catch (e) {
    ztoolkit.log("DBLP 论文搜索反推 PID 失败:", e);
  }

  return null;
}

async function inferDblpPidFromOrcidTitles(
  authorName: string,
  orcidPubs: Publication[],
  options?: { maxTitles?: number; perTitleHits?: number }
): Promise<string | null> {
  const target = normalizePersonName(authorName);
  const maxTitles = options?.maxTitles ?? 10;
  const perTitleHits = options?.perTitleHits ?? 5;

  const titles = (orcidPubs || [])
    .map((p) => p.title)
    .filter(Boolean)
    .slice(0, maxTitles);
  if (titles.length === 0) return null;

  const pidCount = new Map<string, number>();

  for (let i = 0; i < titles.length; i++) {
    const t = titles[i];
    try {
      const url = `https://dblp.org/search/publ/api?q=${encodeURIComponent(
        t
      )}&format=json&h=${perTitleHits}`;
      const resp = await fetch(url, {
        headers: { Accept: "application/json" },
        cache: "no-store"
      });
      if (!resp.ok) continue;
      const json = (await resp.json()) as any;
      const hits = json.result?.hits?.hit || [];

      for (const h of hits) {
        const info = h.info || {};
        const authorsData = info.authors?.author || [];
        const authorsList = Array.isArray(authorsData) ? authorsData : [authorsData];
        for (const a of authorsList) {
          if (typeof a !== "object") continue;
          const name = a.text || a["#text"] || "";
          const pid = a["@pid"] || "";
          if (!name || !pid) continue;
          if (normalizePersonName(name) === target) {
            pidCount.set(pid, (pidCount.get(pid) || 0) + 1);
          }
        }
      }
    } catch (e) {
      // 单篇失败不影响整体
      ztoolkit.log("DBLP 按标题反推 PID 失败:", e);
    }
  }

  // 选择出现次数最多的 pid；命中 >=2 认为可靠，否则返回 null 交给其他策略
  let bestPid = "";
  let bestCount = 0;
  for (const [pid, count] of pidCount.entries()) {
    if (count > bestCount) {
      bestPid = pid;
      bestCount = count;
    }
  }
  if (bestPid && bestCount >= 2) return bestPid;
  return null;
}

function calcTitleOverlapScore(
  orcidPubs: Publication[],
  dblpPubs: Publication[]
): number {
  const orcidSet = new Set(orcidPubs.map((p) => normalizeTitle(p.title)));
  let overlap = 0;
  for (const p of dblpPubs.slice(0, 30)) {
    const t = normalizeTitle(p.title);
    if (t && orcidSet.has(t)) overlap++;
  }
  return overlap;
}

async function findFirstMatchingDblpAuthorByOverlap(
  authorName: string,
  orcidPubs: Publication[],
  onProgress?: (current: number, total: number, candidateName: string) => void
): Promise<{ pid: string; name: string } | null> {
  const rawCandidates = await searchDblpAuthorsByName(authorName);
  const target = normalizePersonName(authorName);
  // 只保留“名字一模一样（忽略编号差异/有无编号）”的候选
  const candidates = rawCandidates.filter(
    (c) => normalizePersonName(c.name) === target
  );
  if (candidates.length === 0) return null;

  // 先用“多篇 ORCID 标题 -> DBLP publ 搜索 -> pid 统计”来反推（更稳）
  const inferredByTitles = await inferDblpPidFromOrcidTitles(authorName, orcidPubs, {
    maxTitles: 12,
    perTitleHits: 5,
  });
  if (inferredByTitles) return { pid: inferredByTitles, name: authorName };

  // ORCID 没有论文（或为空）时：用姓名在 DBLP 论文搜索里反推 PID
  if (!orcidPubs || orcidPubs.length === 0) {
    const inferredPid = await inferDblpPidFromPublicationSearch(authorName);
    if (inferredPid) return { pid: inferredPid, name: authorName };
  }

  for (let i = 0; i < candidates.length; i++) {
    const c = candidates[i];
    onProgress?.(i + 1, candidates.length, c.name);

    // 匹配阶段只取少量论文用于重合判断，避免拉取全量太慢
    const pubs = await fetchDblpAuthorPublications(c.pid, { limit: 200 });
    const overlap = calcTitleOverlapScore(orcidPubs, pubs);
    // 只要有 1 篇标题重合，就认为是同一作者（按你的要求不弹窗确认）
    if (overlap >= 1) {
      return { pid: c.pid, name: c.name };
    }
  }

  // 重合匹配失败：最后再用姓名反推一次
  const inferredPid = await inferDblpPidFromPublicationSearch(authorName);
  if (inferredPid) return { pid: inferredPid, name: authorName };

  return null;
}

function mergePublicationsKeepUnique(
  base: Publication[],
  extra: Publication[]
): Publication[] {
  const out: Publication[] = [];

  // doi -> index
  const doiIndex = new Map<string, number>();
  // title|year -> index
  const titleYearIndex = new Map<string, number>();
  // title -> index（用于年份缺失时的兜底合并）
  const titleOnlyIndex = new Map<string, number>();

  const mergeInto = (target: Publication, incoming: Publication) => {
    // 更完整字段优先（例如补上 year/venue/doi/url）
    if (!target.year && incoming.year) target.year = incoming.year;
    if (!target.venue && incoming.venue) target.venue = incoming.venue;
    if (!target.doi && incoming.doi) target.doi = incoming.doi;
    if (!target.url && incoming.url) target.url = incoming.url;
    if (!target.type && incoming.type) target.type = incoming.type;
    // title 以较长者优先（避免被截断）
    if ((incoming.title || "").length > (target.title || "").length) {
      target.title = incoming.title;
    }
  };

  const addOrMerge = (p: Publication) => {
    const doi = normalizeDoi(p.doi);
    const titleNorm = normalizeTitle(p.title);
    const yearNorm = (p.year || "").toString().trim();
    const titleYearKey = `${titleNorm}|${yearNorm}`;

    // 1) DOI 精确合并
    if (doi) {
      const idx = doiIndex.get(doi);
      if (idx !== undefined) {
        mergeInto(out[idx], p);
        return;
      }
    }

    // 2) 标题+年份精确合并
    if (titleNorm) {
      const idx = titleYearIndex.get(titleYearKey);
      if (idx !== undefined) {
        mergeInto(out[idx], p);
        if (doi) doiIndex.set(doi, idx);
        return;
      }
    }

    // 3) 年份缺失兜底：只要标题一致，且任意一方 year 为空，则视为同一条（解决 ORCID 年份空 vs DBLP 有年份）
    if (titleNorm) {
      const idx = titleOnlyIndex.get(titleNorm);
      if (idx !== undefined) {
        const existing = out[idx];
        const existingYear = (existing.year || "").toString().trim();
        if (!existingYear || !yearNorm) {
          mergeInto(existing, p);
          // 更新索引（可能补上了年份/doi）
          const newYear = (existing.year || "").toString().trim();
          titleYearIndex.set(`${titleNorm}|${newYear}`, idx);
          titleOnlyIndex.set(titleNorm, idx);
          const newDoi = normalizeDoi(existing.doi);
          if (newDoi) doiIndex.set(newDoi, idx);
          if (doi) doiIndex.set(doi, idx);
          return;
        }
      }
    }

    // 4) 新增
    const idx = out.length;
    out.push({ ...p });
    if (doi) doiIndex.set(doi, idx);
    if (titleNorm) {
      titleOnlyIndex.set(titleNorm, idx);
      titleYearIndex.set(titleYearKey, idx);
    }
  };

  base.forEach(addOrMerge);
  extra.forEach(addOrMerge);
  return out;
}

// 尝试通过 Unpaywall 获取 PDF URL
async function getPdfUrl(doi: string): Promise<string | null> {
  if (!doi) return null;

  try {
    const email = "zotero-plugin@example.com";
    const url = `https://api.unpaywall.org/v2/${encodeURIComponent(
      doi
    )}?email=${email}`;
    const resp = await fetch(url, { cache: "no-store" });

    if (resp.ok) {
      const data = (await resp.json()) as any;
      if (data.best_oa_location?.url_for_pdf) {
        return data.best_oa_location.url_for_pdf;
      }
      for (const loc of data.oa_locations || []) {
        if (loc.url_for_pdf) {
          return loc.url_for_pdf;
        }
      }
    }
  } catch (e) {
    ztoolkit.log("Unpaywall 获取 PDF 失败:", e);
  }
  return null;
}

// 导入论文到"我的出版物"
async function importToMyPublications(
  publications: Publication[],
  onProgress?: (current: number, total: number, title: string) => void
) {
  const ZoteroGlobal = ztoolkit.getGlobal("Zotero") as any;
  const libraryID = ZoteroGlobal.Libraries.userLibraryID;

  let successCount = 0;
  let pdfCount = 0;
  let failCount = 0;
  let skipCount = 0; // 同一批次内重复的记录
  let existedCount = 0; // 库中已存在的记录

  const seenDois = new Set<string>();
  const seenTitleYear = new Set<string>();

  for (let i = 0; i < publications.length; i++) {
    const pub = publications[i];
    const normalizedDoi = normalizeDoi(pub.doi);
    const titleYearKey = buildTitleYearKey(pub);

    // 批次内去重：优先按 DOI，其次标题+年份
    if (normalizedDoi) {
      if (seenDois.has(normalizedDoi)) {
        skipCount++;
        continue;
      }
      seenDois.add(normalizedDoi);
    }
    if (seenTitleYear.has(titleYearKey)) {
      skipCount++;
      continue;
    }
    seenTitleYear.add(titleYearKey);

    if (onProgress) {
      onProgress(i + 1, publications.length, pub.title);
    }

    try {
      let existingItem: any = null;

      // 1) 先按规范化 DOI 查找（contains + is）
      existingItem = await findExistingByDoi(
        ZoteroGlobal,
        libraryID,
        normalizedDoi || pub.doi
      );

      // 2) 若 DOI 未找到或为空，则按标题+年份查找（contains 后规范化比对）
      if (!existingItem && titleYearKey.trim() !== "|") {
        existingItem = await findExistingByTitleYear(
          ZoteroGlobal,
          libraryID,
          pub.title,
          pub.year
        );
      }

      // 如果库里已有条目，直接标记为我的出版物，跳过创建
      if (existingItem) {
        existingItem.inPublications = true;
        await existingItem.saveTx();
        existedCount++;
        continue;
      }

      // 创建新条目
      const item: any = new ZoteroGlobal.Item("journalArticle");
      item.libraryID = libraryID;
      item.setField("title", pub.title);
      if (pub.year) item.setField("date", pub.year);
      if (pub.venue) item.setField("publicationTitle", pub.venue);
      if (normalizedDoi) item.setField("DOI", normalizedDoi);
      if (pub.url) item.setField("url", pub.url);
      await item.saveTx();

      item.inPublications = true;
      await item.saveTx();

      // 尝试获取 PDF
      if (normalizedDoi) {
        const pdfUrl = await getPdfUrl(normalizedDoi);
        if (pdfUrl) {
          try {
            await ZoteroGlobal.Attachments.importFromURL({
              libraryID: libraryID,
              url: pdfUrl,
              parentItemID: item.id,
              contentType: "application/pdf",
            });
            pdfCount++;
          } catch (pdfError) {
            ztoolkit.log("PDF 下载失败:", pub.title, pdfError);
          }
        }
      }

      successCount++;
    } catch (e) {
      ztoolkit.log("导入论文失败:", pub.title, e);
      failCount++;
    }
  }

  return { successCount, pdfCount, failCount, skipCount, existedCount };
}

// 显示添加论文对话框
async function showAddPaperDialog(onAdd: (pub: Publication) => void) {
  const dialog = new ztoolkit.Dialog(5, 2)
    .addCell(0, 0, {
      tag: "label",
      properties: { innerText: "标题 *" },
      styles: { padding: "8px", fontWeight: "bold" },
    })
    .addCell(0, 1, {
      tag: "input",
      id: "add-paper-title",
      namespace: "html",
      attributes: { type: "text" },
      styles: { width: "300px", padding: "6px" },
    })
    .addCell(1, 0, {
      tag: "label",
      properties: { innerText: "年份" },
      styles: { padding: "8px" },
    })
    .addCell(1, 1, {
      tag: "input",
      id: "add-paper-year",
      namespace: "html",
      attributes: { type: "text", placeholder: "如：2024" },
      styles: { width: "100px", padding: "6px" },
    })
    .addCell(2, 0, {
      tag: "label",
      properties: { innerText: "期刊/会议" },
      styles: { padding: "8px" },
    })
    .addCell(2, 1, {
      tag: "input",
      id: "add-paper-venue",
      namespace: "html",
      attributes: { type: "text" },
      styles: { width: "300px", padding: "6px" },
    })
    .addCell(3, 0, {
      tag: "label",
      properties: { innerText: "DOI" },
      styles: { padding: "8px" },
    })
    .addCell(3, 1, {
      tag: "input",
      id: "add-paper-doi",
      namespace: "html",
      attributes: { type: "text", placeholder: "如：10.1000/xyz123" },
      styles: { width: "300px", padding: "6px" },
    })
    .addButton("添加", "add", {
      callback: (e: any) => {
        const target = e.target as HTMLElement;
        const doc = target.ownerDocument;
        if (!doc) return;

        const titleEl = doc.getElementById(
          "add-paper-title"
        ) as HTMLInputElement | null;
        const title = titleEl?.value?.trim();
        if (!title) {
          ztoolkit.getGlobal("alert")("请输入论文标题");
          return;
        }

        const yearEl = doc.getElementById(
          "add-paper-year"
        ) as HTMLInputElement | null;
        const venueEl = doc.getElementById(
          "add-paper-venue"
        ) as HTMLInputElement | null;
        const doiEl = doc.getElementById(
          "add-paper-doi"
        ) as HTMLInputElement | null;

        const year = yearEl?.value?.trim();
        const venue = venueEl?.value?.trim();
        const doiRaw = doiEl?.value?.trim();
        const normalizedDoi = normalizeDoi(doiRaw);

        onAdd({
          title,
          year,
          venue,
          doi: normalizedDoi || undefined,
          url: normalizedDoi ? `https://doi.org/${normalizedDoi}` : "",
        });
      },
    })
    .addButton("取消", "cancel");

  dialog.open("添加论文");
}

// 通用添加记录对话框（标题必填，其余可选）
function showAddRecordDialog(
  options: {
    titleLabel: string;
    yearPlaceholder?: string;
    venueLabel: string;
    venuePlaceholder?: string;
    detailLabel: string;
    detailPlaceholder?: string;
  },
  onAdd: (record: {
    title: string;
    year?: string;
    venue?: string;
    detail?: string;
  }) => void
) {
  const dialog = new ztoolkit.Dialog(5, 2)
    .addCell(0, 0, {
      tag: "label",
      properties: { innerText: options.titleLabel },
      styles: { padding: "8px", fontWeight: "bold" },
    })
    .addCell(0, 1, {
      tag: "input",
      id: "add-record-title",
      namespace: "html",
      attributes: { type: "text" },
      styles: { width: "300px", padding: "6px" },
    })
    .addCell(1, 0, {
      tag: "label",
      properties: { innerText: "年份" },
      styles: { padding: "8px" },
    })
    .addCell(1, 1, {
      tag: "input",
      id: "add-record-year",
      namespace: "html",
      attributes: { type: "text", placeholder: options.yearPlaceholder || "" },
      styles: { width: "100px", padding: "6px" },
    })
    .addCell(2, 0, {
      tag: "label",
      properties: { innerText: options.venueLabel },
      styles: { padding: "8px" },
    })
    .addCell(2, 1, {
      tag: "input",
      id: "add-record-venue",
      namespace: "html",
      attributes: { type: "text", placeholder: options.venuePlaceholder || "" },
      styles: { width: "300px", padding: "6px" },
    })
    .addCell(3, 0, {
      tag: "label",
      properties: { innerText: options.detailLabel },
      styles: { padding: "8px" },
    })
    .addCell(3, 1, {
      tag: "input",
      id: "add-record-detail",
      namespace: "html",
      attributes: { type: "text", placeholder: options.detailPlaceholder || "" },
      styles: { width: "300px", padding: "6px" },
    })
    .addButton("添加", "add", {
      callback: (e: any) => {
        const target = e.target as HTMLElement;
        const doc = target.ownerDocument;
        if (!doc) return;

        const titleEl = doc.getElementById(
          "add-record-title"
        ) as HTMLInputElement | null;
        const title = titleEl?.value?.trim();
        if (!title) {
          ztoolkit.getGlobal("alert")("请输入标题");
          return;
        }

        const yearEl = doc.getElementById(
          "add-record-year"
        ) as HTMLInputElement | null;
        const venueEl = doc.getElementById(
          "add-record-venue"
        ) as HTMLInputElement | null;
        const detailEl = doc.getElementById(
          "add-record-detail"
        ) as HTMLInputElement | null;

        onAdd({
          title,
          year: yearEl?.value?.trim(),
          venue: venueEl?.value?.trim(),
          detail: detailEl?.value?.trim(),
        });
      },
    })
    .addButton("取消", "cancel");

  dialog.open("添加记录");
}

// 将 Publication 数组转为表格行数据
function publicationsToRows(
  publications: Publication[]
): { [dataKey: string]: string }[] {
  return publications.map((p) => ({
    title: p.title,
    year: p.year || "",
    venue: p.venue || "",
    detail: p.doi || "",
  }));
}

function patentsToRows(patents: Patent[]): { [dataKey: string]: string }[] {
  return patents.map((p) => ({
    title: p.title,
    year: p.year || "",
    venue: p.office || "",
    detail: p.number || "",
  }));
}

function datasetsToRows(datasets: Dataset[]): { [dataKey: string]: string }[] {
  return datasets.map((p) => ({
    title: p.title,
    year: p.year || "",
    venue: p.repo || "",
    detail: p.doi || "",
  }));
}

function projectsToRows(projects: Project[]): { [dataKey: string]: string }[] {
  return projects.map((p) => ({
    title: p.title,
    year: p.year || "",
    venue: p.funder || "",
    detail: p.grantId || "",
  }));
}

type TableKey = "publications" | "patents" | "datasets" | "projects";

interface TableState {
  window?: Window;
  columns: any[];
  rows: { [dataKey: string]: string }[];
  tableHelper?: any;
}

const tableConfigs: Record<
  TableKey,
  { containerId: string; tableId: string; columns: any[] }
> = {
  publications: {
    containerId: `${config.addonRef}-table-container`,
    tableId: `${config.addonRef}-prefs-table`,
    columns: [
      { dataKey: "title", label: "标题", fixedWidth: false },
      { dataKey: "year", label: "年份", fixedWidth: true, width: 60 },
      { dataKey: "venue", label: "期刊/会议", fixedWidth: true, width: 150 },
    ],
  },
  patents: {
    containerId: `${config.addonRef}-patent-table-container`,
    tableId: `${config.addonRef}-patent-table`,
    columns: [
      { dataKey: "title", label: "专利标题", fixedWidth: false },
      { dataKey: "year", label: "年份", fixedWidth: true, width: 60 },
      { dataKey: "venue", label: "专利局/申请人", fixedWidth: true, width: 150 },
    ],
  },
  datasets: {
    containerId: `${config.addonRef}-dataset-table-container`,
    tableId: `${config.addonRef}-dataset-table`,
    columns: [
      { dataKey: "title", label: "数据集标题", fixedWidth: false },
      { dataKey: "year", label: "年份", fixedWidth: true, width: 60 },
      { dataKey: "venue", label: "仓储/平台", fixedWidth: true, width: 150 },
    ],
  },
  projects: {
    containerId: `${config.addonRef}-project-table-container`,
    tableId: `${config.addonRef}-project-table`,
    columns: [
      { dataKey: "title", label: "项目名称", fixedWidth: false },
      { dataKey: "year", label: "年份", fixedWidth: true, width: 60 },
      { dataKey: "venue", label: "资助方/机构", fixedWidth: true, width: 150 },
    ],
  },
};

// 保存各表状态，兼容原有 addon.data.prefs（论文）
function getTableState(key: TableKey): TableState {
  const store = (addon.data as any)[key] as TableState | undefined;
  return store as TableState;
}

function setTableState(key: TableKey, state: TableState) {
  (addon.data as any)[key] = state;
}

const expandedFlags: Record<TableKey, boolean> = {
  publications: false,
  patents: false,
  datasets: false,
  projects: false,
};

function getVisibleRows(key: TableKey): { [dataKey: string]: string }[] {
  const rows = getTableState(key)?.rows || [];
  if (expandedFlags[key]) return rows;
  return rows.slice(0, 2);
}

function updateTableWrapperHeights(doc: Document) {
  const rowHeight = 28;
  const headerHeight = 30;
  const padding = 24;
  const footerHeight = 28; // 底部折叠条（线+按钮）的高度估算（与 XHTML 中 min-height 对齐）
  const configs: Array<{
    key: TableKey;
    wrapperId: string;
    expandedStyle: { min: string; h: string; max: string };
  }> = [
      {
        key: "publications",
        wrapperId: `${config.addonRef}-pubs-table-wrapper`,
        expandedStyle: { min: "360px", h: "440px", max: "640px" },
      },
      {
        key: "patents",
        wrapperId: `${config.addonRef}-patent-table-wrapper`,
        expandedStyle: { min: "220px", h: "260px", max: "360px" },
      },
      {
        key: "datasets",
        wrapperId: `${config.addonRef}-dataset-table-wrapper`,
        expandedStyle: { min: "220px", h: "260px", max: "360px" },
      },
      {
        key: "projects",
        wrapperId: `${config.addonRef}-project-table-wrapper`,
        expandedStyle: { min: "220px", h: "260px", max: "360px" },
      },
    ];

  for (const c of configs) {
    const el = doc.getElementById(c.wrapperId) as HTMLElement | null;
    if (!el) continue;

    const rows = getTableState(c.key)?.rows || [];
    const showToggleBar = rows.length > 2;
    // 0 条：完全折叠（隐藏容器，避免任何空白）
    if (rows.length === 0 && !expandedFlags[c.key]) {
      el.style.display = "none";
      continue;
    }
    el.style.display = "";

    // <=2 条：无论是否展开，都应该紧凑显示且不出现折叠条占位
    if (rows.length <= 2) {
      const visibleCount = rows.length;
      const collapsedHeightPx = Math.max(
        72,
        headerHeight + rowHeight * visibleCount + padding
      );
      const h = `${collapsedHeightPx}px`;
      el.style.minHeight = h;
      el.style.height = h;
      el.style.maxHeight = h;
      continue;
    }

    if (!expandedFlags[c.key]) {
      // 折叠：只显示 2 行，且底部折叠条存在时要计入高度
      const visibleCount = 2;
      const collapsedHeightPx = Math.max(
        80,
        headerHeight +
        rowHeight * visibleCount +
        padding +
        (showToggleBar ? footerHeight : 0)
      );
      const h = `${collapsedHeightPx}px`;
      el.style.minHeight = h;
      el.style.height = h;
      el.style.maxHeight = h;
    } else {
      el.style.minHeight = c.expandedStyle.min;
      el.style.height = c.expandedStyle.h;
      el.style.maxHeight = c.expandedStyle.max;
    }
  }
}

function ensureTableState(
  key: TableKey,
  _window: Window,
  rows: { [dataKey: string]: string }[]
) {
  let state = getTableState(key);
  if (!state) {
    state = {
      window: _window,
      columns: tableConfigs[key].columns,
      rows,
      tableHelper: undefined,
    };
    setTableState(key, state);
  } else {
    state.window = _window;
    state.columns = state.columns || tableConfigs[key].columns;
    state.rows = rows;
  }
  // 初始化折叠状态，默认折叠（仅显示前两条）
  expandedFlags[key] = false;
}

// 填充作者信息表单
function fillAuthorForm(doc: Document, info: AuthorInfo | null) {
  const nameInput = doc.getElementById(
    `zotero-prefpane-${config.addonRef}-author-name`
  ) as HTMLInputElement | null;
  const affiliationInput = doc.getElementById(
    `zotero-prefpane-${config.addonRef}-author-affiliation`
  ) as HTMLInputElement | null;
  const countryInput = doc.getElementById(
    `zotero-prefpane-${config.addonRef}-author-country`
  ) as HTMLInputElement | null;
  const keywordsInput = doc.getElementById(
    `zotero-prefpane-${config.addonRef}-author-keywords`
  ) as HTMLInputElement | null;
  const bioInput = doc.getElementById(
    `zotero-prefpane-${config.addonRef}-author-bio`
  ) as HTMLTextAreaElement | null;
  const websiteInput = doc.getElementById(
    `zotero-prefpane-${config.addonRef}-author-website`
  ) as HTMLInputElement | null;

  if (info) {
    if (nameInput) nameInput.value = info.name || "";
    if (affiliationInput) affiliationInput.value = info.affiliation || "";
    if (countryInput) countryInput.value = info.country || "";
    if (keywordsInput) keywordsInput.value = info.keywords || "";
    if (bioInput) bioInput.value = info.biography || "";
    if (websiteInput) websiteInput.value = info.website || "";
  }
}

// 从表单获取作者信息
function getAuthorInfoFromForm(doc: Document): AuthorInfo {
  const orcidInput = doc.getElementById(
    `zotero-prefpane-${config.addonRef}-orcid`
  ) as HTMLInputElement | null;
  const nameInput = doc.getElementById(
    `zotero-prefpane-${config.addonRef}-author-name`
  ) as HTMLInputElement | null;
  const affiliationInput = doc.getElementById(
    `zotero-prefpane-${config.addonRef}-author-affiliation`
  ) as HTMLInputElement | null;
  const countryInput = doc.getElementById(
    `zotero-prefpane-${config.addonRef}-author-country`
  ) as HTMLInputElement | null;
  const keywordsInput = doc.getElementById(
    `zotero-prefpane-${config.addonRef}-author-keywords`
  ) as HTMLInputElement | null;
  const bioInput = doc.getElementById(
    `zotero-prefpane-${config.addonRef}-author-bio`
  ) as HTMLTextAreaElement | null;
  const websiteInput = doc.getElementById(
    `zotero-prefpane-${config.addonRef}-author-website`
  ) as HTMLInputElement | null;

  return {
    orcid: orcidInput?.value?.trim() || "",
    name: nameInput?.value?.trim() || "",
    affiliation: affiliationInput?.value?.trim() || "",
    country: countryInput?.value?.trim() || "",
    keywords: keywordsInput?.value?.trim() || "",
    biography: bioInput?.value?.trim() || "",
    website: websiteInput?.value?.trim() || "",
    customFields: authorInfoData?.customFields || [],
  };
}

/**
 * 偏好页里的 AI 聊天窗口：
 * 使用当前表单中的作者信息 + 已保存的论文列表，调用 DeepSeek 进行推荐和问答。
 */
async function showPrefsAIChat(doc: Document) {
  // 复用 authorProfile.ts 中的 DeepSeek 配置（注意保持 key 一致）
  const DEEPSEEK_API_BASE = "https://api.deepseek.com/v1";
  const DEEPSEEK_MODEL = "deepseek-chat";
  const DEEPSEEK_API_KEY = "sk-3d674ad887e644d4afa9601bfcb2a177";

  type ChatRole = "system" | "user" | "assistant";
  type ChatMessage = { role: ChatRole; content: string };

  const author = getAuthorInfoFromForm(doc);
  const pubs = loadPublications();

  const pubsText =
    pubs.length > 0
      ? pubs
        .slice(0, 15)
        .map(
          (p, i) =>
            `${i + 1}. ${p.title} (${p.year || "-"}${p.venue ? `, ${p.venue}` : ""})`
        )
        .join("\n")
      : "暂无已维护的论文列表";

  const systemPrompt = `你是一个学术助手，负责根据研究者的学术简历推荐论文和相关资源，并进行自然语言问答。

研究者信息（来自插件偏好页）：
- 姓名：${author.name || "未知"}
- 单位：${author.affiliation || "未知"}
- 国家/地区：${author.country || "未知"}
- 研究关键词：${author.keywords || "未填写"}

当前维护的论文列表：
${pubsText}

你的能力：
1. 基于以上信息推荐 5~10 篇代表性或相关论文，并说明推荐理由；
2. 推荐 3~5 个相关资源，如：数据集、科研工具、重要会议、期刊等；
3. 支持用户用自然语言继续追问，例如“再推荐几篇开源数据集的论文”“帮我总结我的研究方向”等；
4. 回答要尽量给出 title、作者、年份和大致来源，并尽量附带 DOI 或可访问的链接（如果你知道的话）。

回答风格：
- 用中文回答；
- 分点列出推荐论文与资源；`;

  async function callDeepseek(messages: ChatMessage[]): Promise<string> {
    if (!DEEPSEEK_API_KEY || DEEPSEEK_API_KEY.startsWith("<")) {
      throw new Error("DeepSeek API Key 未配置，请在代码中设置 DEEPSEEK_API_KEY");
    }

    const resp = await fetch(`${DEEPSEEK_API_BASE}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${DEEPSEEK_API_KEY}`,
      },
      body: JSON.stringify({
        model: DEEPSEEK_MODEL,
        messages,
        temperature: 0.7,
      }),
    });

    if (!resp.ok) {
      const t = await resp.text().catch(() => "");
      throw new Error(`DeepSeek 调用失败: ${resp.status} ${resp.statusText} ${t}`);
    }

    const data: any = await resp.json();
    const c =
      data.choices?.[0]?.message?.content ??
      data.choices?.[0]?.delta?.content ??
      "";
    if (!c) throw new Error("DeepSeek 返回内容为空");
    return c as string;
  }

  const dialog = new ztoolkit.Dialog(1, 1);
  dialog.addCell(
    0,
    0,
    {
      tag: "div",
      namespace: "html",
      id: "prefs-ai-chat-root",
      styles: {
        width: "780px",
        height: "560px",
        padding: "0",
        overflow: "hidden",
        display: "flex",
        flexDirection: "column",
        fontFamily:
          "system-ui, -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif",
        fontSize: "13px",
        color: "#222",
      },
    },
    true
  );

  dialog.setDialogData({
    loadCallback: async () => {
      const win = dialog.window;
      const d = win.document;
      const root = d.getElementById("prefs-ai-chat-root") as HTMLElement | null;
      if (!root) return;

      // 用原生 DOM 创建，避免某些环境下 innerHTML 渲染不出按钮
      const ns = "http://www.w3.org/1999/xhtml";
      const wrap = d.createElementNS(ns, "div") as HTMLElement;
      wrap.style.display = "flex";
      wrap.style.flexDirection = "column";
      wrap.style.height = "100%";

      const header = d.createElementNS(ns, "div") as HTMLElement;
      header.style.padding = "10px 14px";
      header.style.borderBottom = "1px solid #e0e0e0";
      header.style.background = "#f5f5f5";
      const hTitle = d.createElementNS(ns, "div") as HTMLElement;
      hTitle.style.fontWeight = "600";
      hTitle.style.color = "#1a237e";
      hTitle.style.fontSize = "14px";
      hTitle.textContent = "🤖 AI 推荐";
      const hSub = d.createElementNS(ns, "div") as HTMLElement;
      hSub.style.fontSize = "12px";
      hSub.style.color = "#555";
      hSub.style.marginTop = "4px";
      hSub.textContent =
        "基于“作者信息 + 论文列表”自动推荐论文/资源，也支持自由问答。";
      header.appendChild(hTitle);
      header.appendChild(hSub);

      const historyEl = d.createElementNS(ns, "div") as HTMLElement;
      historyEl.id = "prefs-ai-chat-history";
      historyEl.style.flex = "1";
      historyEl.style.padding = "10px 14px";
      historyEl.style.overflow = "auto";
      historyEl.style.background = "#fafafa";

      const footer = d.createElementNS(ns, "div") as HTMLElement;
      footer.style.borderTop = "1px solid #e0e0e0";
      footer.style.padding = "8px 10px";
      footer.style.background = "#fff";

      const inputEl = d.createElementNS(ns, "textarea") as HTMLTextAreaElement;
      inputEl.id = "prefs-ai-chat-input";
      inputEl.rows = 3;
      inputEl.style.width = "100%";
      inputEl.style.boxSizing = "border-box";
      inputEl.style.resize = "vertical";
      inputEl.style.fontSize = "13px";
      inputEl.style.padding = "6px 8px";

      const btnRow = d.createElementNS(ns, "div") as HTMLElement;
      btnRow.style.marginTop = "6px";
      btnRow.style.display = "flex";
      btnRow.style.justifyContent = "flex-end";
      btnRow.style.gap = "8px";

      const sendBtn = d.createElementNS(ns, "button") as HTMLButtonElement;
      sendBtn.id = "prefs-ai-chat-send";
      sendBtn.textContent = "发送";
      sendBtn.style.padding = "4px 12px";
      sendBtn.style.fontWeight = "600";

      btnRow.appendChild(sendBtn);
      footer.appendChild(inputEl);
      footer.appendChild(btnRow);

      wrap.appendChild(header);
      wrap.appendChild(historyEl);
      wrap.appendChild(footer);
      root.textContent = "";
      root.appendChild(wrap);

      const messages: ChatMessage[] = [
        { role: "system", content: systemPrompt },
      ];

      function appendBubble(role: ChatRole, content: string) {
        const wrap = d.createElement("div");
        wrap.style.marginBottom = "10px";
        wrap.style.display = "flex";
        wrap.style.justifyContent =
          role === "user" ? "flex-end" : "flex-start";

        const bubble = d.createElement("div");
        bubble.style.maxWidth = "80%";
        bubble.style.padding = "8px 10px";
        bubble.style.borderRadius = "8px";
        bubble.style.whiteSpace = "pre-wrap";
        bubble.style.lineHeight = "1.5";
        bubble.style.fontSize = "13px";
        bubble.style.boxShadow = "0 1px 2px rgba(0,0,0,0.08)";

        if (role === "user") {
          bubble.style.background = "#e3f2fd";
          bubble.style.color = "#0d47a1";
        } else {
          bubble.style.background = "#ffffff";
          bubble.style.color = "#333333";
        }

        bubble.textContent = content;
        wrap.appendChild(bubble);
        historyEl!.appendChild(wrap);
        historyEl!.scrollTop = historyEl!.scrollHeight;
      }

      let sending = false;

      async function sendUserMessage(text: string) {
        const q = text.trim();
        if (!q || sending) return;
        sending = true;

        appendBubble("user", q);
        inputEl!.value = "";
        messages.push({ role: "user", content: q });

        const loadingText = "🤖 正在思考中，请稍候…";
        appendBubble("assistant", loadingText);
        const loadingNode = historyEl!.lastElementChild as HTMLElement | null;

        try {
          const reply = await callDeepseek(messages);
          if (loadingNode && loadingNode.parentElement === historyEl) {
            historyEl!.removeChild(loadingNode);
          }
          appendBubble("assistant", reply);
          messages.push({ role: "assistant", content: reply });
        } catch (e: any) {
          if (loadingNode && loadingNode.parentElement === historyEl) {
            historyEl!.removeChild(loadingNode);
          }
          const msg = e?.message || String(e);
          appendBubble("assistant", `调用大模型失败：${msg}`);
          ztoolkit.log("DeepSeek 调用失败 (prefs):", e);
        } finally {
          sending = false;
        }
      }

      sendBtn.addEventListener("click", () => {
        sendUserMessage(inputEl.value);
      });

      inputEl.addEventListener("keydown", (ev: KeyboardEvent) => {
        if (ev.key === "Enter" && !ev.shiftKey) {
          ev.preventDefault();
          sendUserMessage(inputEl.value);
        }
      });

      // 打开窗口后自动触发一次推荐（直接调用，避免按钮渲染问题）
      win.setTimeout(() => {
        sendUserMessage(
          "请基于上面的作者信息和论文列表，推荐 5~10 篇代表性或相关论文，并推荐 3~5 个相关的研究资源（如数据集、工具、重要期刊或会议），用中文分点列出，并简要说明推荐理由，并写出更具体的论文、数据集、工具、会议等。"
        );
      }, 120);
    },
  });

  dialog.addButton("关闭", "close");
  dialog.open("AI 推荐", {
    width: 820,
    height: 640,
    resizable: true,
    centerscreen: true,
    noDialogMode: true,
  });
}

export async function registerPrefsScripts(_window: Window) {
  // 初始化数据
  const publications = loadPublications();
  const patents = loadPatents();
  const datasets = loadDatasets();
  const projects = loadProjects();
  const savedAuthorInfo = loadAuthorInfo();

  // 兼容旧字段：把 publications 表仍放在 prefs
  ensureTableState("publications", _window, publicationsToRows(publications));
  const pubState = getTableState("publications");
  (addon.data as any).prefs = pubState; // 兼容旧字段

  ensureTableState("patents", _window, patentsToRows(patents));
  ensureTableState("datasets", _window, datasetsToRows(datasets));
  ensureTableState("projects", _window, projectsToRows(projects));

  // 加载已保存的 ORCID
  const savedOrcid = getPref("orcid") || "";
  const orcidInput = _window.document.getElementById(
    `zotero-prefpane-${config.addonRef}-orcid`
  ) as HTMLInputElement;
  if (orcidInput && savedOrcid) {
    orcidInput.value = savedOrcid;
  }

  // ========== 加载 LLM 配置 ==========
  const llmProvider = getPref("llmProvider" as any) || 'deepseek';
  const llmModel = getPref("llmModel" as any) || getDefaultModel(llmProvider as any);
  const llmApiKey = getPref("llmApiKey" as any) || '';
  const llmBaseUrl = getPref("llmBaseUrl" as any) || '';

  const providerSelect = _window.document.getElementById(
    `zotero-prefpane-${config.addonRef}-llm-provider`
  ) as HTMLSelectElement;
  const modelSelect = _window.document.getElementById(
    `zotero-prefpane-${config.addonRef}-llm-model`
  ); // XUL menulist
  const apiKeyInput = _window.document.getElementById(
    `zotero-prefpane-${config.addonRef}-llm-api-key`
  ) as HTMLInputElement;
  const baseUrlInput = _window.document.getElementById(
    `zotero-prefpane-${config.addonRef}-llm-base-url`
  ) as HTMLInputElement;

  if (providerSelect) providerSelect.value = llmProvider;
  // 填充已保存的模型到 menulist
  if (modelSelect && llmModel) {
    addMenuItemToMenulist(modelSelect, llmModel, llmModel);
    setMenulistValue(modelSelect, llmModel);
  }
  if (apiKeyInput) apiKeyInput.value = llmApiKey;
  if (baseUrlInput) baseUrlInput.value = llmBaseUrl;

  // 提供商选择变化时，清空模型列表并提示重新获取
  if (providerSelect) {
    providerSelect.addEventListener('change', () => {
      if (modelSelect) {
        clearMenulistPopup(modelSelect);
        addMenuItemToMenulist(modelSelect, '-- 切换了 Provider, 请重新 Fetch Models --', '');
        setMenulistValue(modelSelect, '');
      }
    });
  }

  if (modelSelect) {
    attachModelSelectChangeListener(modelSelect);
  }

  // 填充已保存的作者信息到表单
  if (savedAuthorInfo) {
    fillAuthorForm(_window.document, savedAuthorInfo);
  }

  // ========== 新增：渲染自定义字段UI ==========
  // 1. 获取作者信息区域的父容器（需与设置页HTML中的ID对应）
  const authorInfoContainer = _window.document.getElementById(
    `zotero-prefpane-${config.addonRef}-author-info-container`
  );
  // 2. 若容器存在，调用渲染函数生成自定义字段按键和输入框
  if (authorInfoContainer) {
    renderCustomFieldsUI(_window.document, authorInfoContainer);
  } else {
    ztoolkit.log("⚠️ 未找到作者信息容器，无法渲染自定义字段");
  }

  await updatePrefsUI("publications");
  await updatePrefsUI("patents");
  await updatePrefsUI("datasets");
  await updatePrefsUI("projects");
  refreshTable("publications");
  refreshTable("patents");
  refreshTable("datasets");
  refreshTable("projects");
  updateCollapseUI(_window.document);
  bindPrefEvents();

  // ========== Phase 3: 知识库初始化入口 ==========
  initKnowledgeBasePanel(_window);
}

async function updatePrefsUI(key: TableKey) {
  const renderLock = ztoolkit.getGlobal("Zotero").Promise.defer();
  const state = getTableState(key);
  const cfg = tableConfigs[key];
  if (!state?.window) return;

  const tableHelper = new ztoolkit.VirtualizedTable(state.window)
    .setContainerId(cfg.containerId)
    .setProp({
      id: cfg.tableId,
      columns: state.columns,
      showHeader: true,
      multiSelect: true,
      staticColumns: true,
      disableFontSizeScaling: true,
    })
    // @ts-expect-error rowHeight supported at runtime
    .setProp("rowHeight", 28)
    .setProp("getRowCount", () => getVisibleRows(key).length || 0)
    .setProp("getRowData", (index) => {
      const row = getVisibleRows(key)[index];
      return row || { title: "无数据", year: "", venue: "" };
    })
    .setProp(
      "onSelectionChange",
      (selection) => {
        const count = selection.count;
        updateStatus(`已选择 ${count} 条记录`);
      }
    )
    .setProp("onKeyDown", (event: KeyboardEvent) => {
      if (
        event.key === "Delete" ||
        (Zotero.isMac && event.key === "Backspace")
      ) {
        deleteSelectedRows(key);
        return false;
      }
      return true;
    })
    .setProp("getRowString", (index) => getVisibleRows(key)[index]?.title || "")
    .render(getVisibleRows(key).length || 0, () => {
      renderLock.resolve();
    });

  state.tableHelper = tableHelper;
  setTableState(key, state);

  await renderLock.promise;

  scheduleFullRender(key);
  ztoolkit.log(`${key} 列表渲染完成!`);
}

function refreshTable(key: TableKey = "publications") {
  const tableHelper = getTableState(key)?.tableHelper;
  if (tableHelper) {
    scheduleFullRender(key);
  }
}

function toggleCollapse(key: TableKey) {
  expandedFlags[key] = !expandedFlags[key];
  scheduleFullRender(key);
  const doc = getTableState(key)?.window?.document;
  if (doc) {
    updateToggleLabels(doc);
    updateTableWrapperHeights(doc);
  }
}

function updateToggleLabels(doc: Document) {
  const pairs: Array<{
    key: TableKey;
    btnSuffix: string;
    barId: string;
  }> = [
      {
        key: "publications",
        btnSuffix: "toggle-pubs",
        barId: `${config.addonRef}-pubs-togglebar`,
      },
      {
        key: "patents",
        btnSuffix: "toggle-patents",
        barId: `${config.addonRef}-patent-togglebar`,
      },
      {
        key: "datasets",
        btnSuffix: "toggle-datasets",
        barId: `${config.addonRef}-dataset-togglebar`,
      },
      {
        key: "projects",
        btnSuffix: "toggle-projects",
        barId: `${config.addonRef}-project-togglebar`,
      },
    ];

  for (const p of pairs) {
    const { key } = p;
    const btn = doc.querySelector(
      `#zotero-prefpane-${config.addonRef}-${p.btnSuffix}`
    ) as HTMLElement | null;
    const bar = doc.getElementById(p.barId) as HTMLElement | null;
    if (btn) {
      // 底部箭头：展开 ▼，折叠 ▲
      btn.setAttribute("label", expandedFlags[key] ? "▲" : "▼");
      btn.setAttribute("title", expandedFlags[key] ? "折叠" : "展开");
      const count = (getTableState(key)?.rows || []).length;
      // <=2 条：无需展开/折叠（隐藏底部条与按钮）；0 条时 wrapper 已隐藏
      const hide = count <= 2;
      btn.setAttribute("hidden", hide ? "true" : "false");
      if (bar) {
        bar.style.display = hide ? "none" : "";
      }
    }
  }
}

function updateCollapseUI(doc: Document) {
  updateToggleLabels(doc);
  updateTableWrapperHeights(doc);
}

// 多次异步刷新，确保 VirtualizedTable 计算高度并滚动到首行
function scheduleFullRender(key: TableKey = "publications") {
  const tableHelper = getTableState(key)?.tableHelper;
  if (!tableHelper) return;
  const rerender = () => {
    try {
      const rowCount = getVisibleRows(key).length || 0;
      // 先让 VirtualizedTable 重新计算（-1 表示 full rerender），再用准确行数刷新
      tableHelper.render(-1);
      tableHelper.render(rowCount);
      const tree = tableHelper.treeInstance;
      tree?.invalidate?.();
      // 强制告知视图行数，防止只渲染尾部几行
      try {
        // rowCountChanged 的第二个参数是增量，但部分实现接受绝对值，这里以绝对值兜底
        tree?.rowCountChanged?.(0, rowCount);
      } catch (e) {
        /* ignore */
      }
      try {
        if (rowCount > 0) {
          // 失效所有行，迫使重绘
          tree?.invalidateRange?.(0, rowCount - 1);
        }
      } catch (e) {
        /* ignore */
      }
      const tb: any = tree?._treebox || tree?.treeBoxObject;
      if (tb?.scrollToRow) tb.scrollToRow(0);
      tree?.ensureRowIsVisible?.(0);
      // 选中第一行再清除，逼视图刷新顶部
      const sel = tree?.selection;
      if (rowCount > 0 && sel?.select) {
        sel.clearSelection();
        sel.select(0);
        tree.ensureRowIsVisible?.(0);
        sel.clearSelection();
      }
    } catch (e) {
      ztoolkit.log("表格刷新失败:", e);
    }
  };
  // 立即一次
  rerender();
  // 50ms 后再来一次
  setTimeout(rerender, 50);
  // 150ms 后再来一次以适配布局
  setTimeout(rerender, 150);
  // 再滚动一次容器顶部
  setTimeout(() => scrollContainerToTop(key), 160);
  // 再次确保树滚到顶部
  setTimeout(() => scrollTreeToTop(key), 180);
  // 模拟一次选择末行再清除，触发树完整布局
  setTimeout(() => pokeSelection(key), 220);
}

// 滚动外层容器到顶部，防止进入页面时停留在底部
function scrollContainerToTop(key: TableKey = "publications") {
  const doc = getTableState(key)?.window?.document;
  if (!doc) return;
  const containerId = tableConfigs[key].containerId;
  const container = doc.getElementById(containerId) as HTMLElement | null;
  if (!container) return;

  const scrollTopOnce = () => {
    try {
      container.scrollTop = 0;
    } catch (e) {
      /* ignore */
    }
  };

  scrollTopOnce();
  setTimeout(scrollTopOnce, 50);
  setTimeout(scrollTopOnce, 200);
}

// 确保树组件也滚到顶部，防止初始停留在底部
function scrollTreeToTop(key: TableKey = "publications") {
  const tableHelper = getTableState(key)?.tableHelper;
  if (!tableHelper?.treeInstance) return;
  const tree = tableHelper.treeInstance;
  const tb: any = tree._treebox || tree.treeBoxObject;

  const scrollOnce = () => {
    try {
      tb?.scrollToRow?.(0);
      tree.ensureRowIsVisible?.(0);
    } catch (e) {
      /* ignore */
    }
  };

  scrollOnce();
  setTimeout(scrollOnce, 50);
  setTimeout(scrollOnce, 200);
}

// 选择最后一行再清除，触发表格内部重算（模拟点击）
function pokeSelection(key: TableKey = "publications") {
  const tableHelper = getTableState(key)?.tableHelper;
  if (!tableHelper?.treeInstance) return;
  const tree = tableHelper.treeInstance;
  const sel = tree.selection;
  const rowCount = getVisibleRows(key).length || 0;
  if (!rowCount || !sel?.select) return;

  try {
    const last = rowCount - 1;
    sel.clearSelection();
    sel.select(last);
    tree.ensureRowIsVisible?.(last);
    // 清除选择并回到顶部
    sel.clearSelection();
    tree.ensureRowIsVisible?.(0);
  } catch (e) {
    /* ignore */
  }
}

// 进入偏好页时自动选中列表最后一行
function selectLastPaperRow(key: TableKey = "publications") {
  const tableHelper = getTableState(key)?.tableHelper;
  const rows = getVisibleRows(key);
  if (!tableHelper || rows.length === 0) return;

  try {
    const lastIndex = rows.length - 1;
    const tree = tableHelper.treeInstance;

    // 先强制一次完整刷新，确保虚拟表格拿到全量 rowCount
    tableHelper.render(rows.length);
    tree?.invalidate?.();

    // 再选中并滚动到最后一行
    if (tree?.selection?.select) {
      tree.selection.select(lastIndex);
      tree.ensureRowIsVisible?.(lastIndex);
      updateStatus("已自动选中最后一条记录");
    }
  } catch (e) {
    ztoolkit.log("自动选中论文行失败:", e);
  }
}

function deleteSelectedRows(key: TableKey = "publications") {
  const tableHelper = getTableState(key)?.tableHelper;
  if (!tableHelper) return;

  const selectedIndices: number[] = [];
  const rows = getVisibleRows(key);
  for (let i = 0; i < rows.length; i++) {
    if (tableHelper.treeInstance.selection.isSelected(i)) {
      selectedIndices.push(i);
    }
  }

  if (selectedIndices.length > 0) {
    const state = getTableState(key);
    if (!state) return;

    const full = state.rows;
    // 如果是折叠视图，需映射到 full 的前几项
    const toRemove = new Set<number>();
    if (!expandedFlags[key]) {
      for (const idx of selectedIndices) {
        if (idx < full.length) {
          toRemove.add(idx);
        }
      }
    } else {
      for (const idx of selectedIndices) {
        toRemove.add(idx);
      }
    }
    state.rows = full.filter((_, i) => !toRemove.has(i));
    setTableState(key, state);

    if (key === "publications") {
      publicationsData = publicationsData.filter(
        (_, i) => !selectedIndices.includes(i)
      );
      savePublications(publicationsData);
    } else if (key === "patents") {
      patentsData = patentsData.filter((_, i) => !selectedIndices.includes(i));
      savePatents(patentsData);
    } else if (key === "datasets") {
      datasetsData = datasetsData.filter(
        (_, i) => !selectedIndices.includes(i)
      );
      saveDatasets(datasetsData);
    } else if (key === "projects") {
      projectsData = projectsData.filter(
        (_, i) => !selectedIndices.includes(i)
      );
      saveProjects(projectsData);
    }

    refreshTable(key);
    updateStatus(`已删除 ${selectedIndices.length} 条记录`);
    const doc = getTableState(key)?.window?.document;
    if (doc) {
      updateCollapseUI(doc);
    }
  } else {
    updateStatus("请先选择要删除的记录");
  }
}

function updateStatus(message: string) {
  if (!addon.data.prefs?.window) return;
  const statusEl = addon.data.prefs.window.document.getElementById(
    `zotero-prefpane-${config.addonRef}-status`
  );
  if (statusEl) {
    statusEl.textContent = message;
  }
}

function bindPrefEvents() {
  const doc = addon.data.prefs!.window.document;
  updateCollapseUI(doc);

  // ORCID 输入框变化时保存
  const orcidInput = doc.querySelector(
    `#zotero-prefpane-${config.addonRef}-orcid`
  ) as HTMLInputElement;
  orcidInput?.addEventListener("change", () => {
    setPref("orcid", orcidInput.value.trim());
  });

  // 获取信息按钮 - 从 ORCID 获取作者信息和论文
  doc
    .querySelector(`#zotero-prefpane-${config.addonRef}-save-orcid`)
    ?.addEventListener("command", async () => {
      const orcid = orcidInput?.value?.trim();
      if (!orcid) {
        updateStatus("请输入 ORCID ID");
        return;
      }

      updateStatus("正在从 ORCID 获取信息...");

      try {
        // 获取作者信息
        const info = await fetchAuthorInfoFromOrcid(orcid);

        // 填充作者信息表单
        fillAuthorForm(doc, info);

        // 仅获取论文（暂不从 ORCID 获取专利/数据集/项目，避免覆盖用户手动维护的数据）
        const publications = await fetchPublicationsFromOrcid(orcid);

        // 更新论文表格数据
        const pubState = getTableState("publications");
        if (pubState) pubState.rows = publicationsToRows(publications);

        // 仅保存论文 + 作者信息 + ORCID
        savePublications(publications);
        saveAuthorInfoToPrefs(info);
        setPref("orcid", orcid);

        scheduleFullRender("publications");
        updateCollapseUI(doc);

        updateStatus(`成功获取作者信息与论文：${publications.length} 篇`);

        // 尝试从外部插件获取专利、数据集、项目数据
        try {
          // 获取专利
          if (checkExternalPluginAvailable("patent")) {
            updateStatus("正在从外部插件获取专利数据...");
            const externalPatents = await fetchPatentsFromExternalPlugin(orcid);
            if (externalPatents.length > 0) {
              const merged = mergePatents(patentsData, externalPatents);
              patentsData = merged;
              const patentState = getTableState("patents");
              if (patentState) patentState.rows = patentsToRows(merged);
              savePatents(merged);
              refreshTable("patents");
              updateCollapseUI(doc);
              updateStatus(`已从外部插件获取 ${externalPatents.length} 条专利数据`);
            }
          }

          // 获取数据集
          if (checkExternalPluginAvailable("dataset")) {
            updateStatus("正在从外部插件获取数据集数据...");
            const externalDatasets = await fetchDatasetsFromExternalPlugin(orcid);

            // 重新展示（覆盖），不再合并
            datasetsData = externalDatasets;
            const datasetState = getTableState("datasets");
            if (datasetState) datasetState.rows = datasetsToRows(datasetsData);
            saveDatasets(datasetsData);
            refreshTable("datasets");
            updateCollapseUI(doc);
            updateStatus(`已从外部插件获取 ${externalDatasets.length} 条数据集数据`);
          }

          // 获取项目
          if (checkExternalPluginAvailable("project")) {
            updateStatus("正在从外部插件获取项目数据...");
            const externalProjects = await fetchProjectsFromExternalPlugin(orcid);
            if (externalProjects.length > 0) {
              const merged = mergeProjects(projectsData, externalProjects);
              projectsData = merged;
              const projectState = getTableState("projects");
              if (projectState) projectState.rows = projectsToRows(merged);
              saveProjects(merged);
              refreshTable("projects");
              updateCollapseUI(doc);
              updateStatus(`已从外部插件获取 ${externalProjects.length} 条项目数据`);
            }
          }
        } catch (e) {
          ztoolkit.log("调用外部插件失败:", e);
          // 不中断主流程，只记录错误
        }

        // DBLP 补充：基于作者姓名 + 与 ORCID 论文标题重合度自动确认后导入（不弹窗）
        try {
          const authorName = info.name?.trim();
          if (authorName) {
            updateStatus("正在从 DBLP 匹配作者并补充论文...");
            const picked = await findFirstMatchingDblpAuthorByOverlap(
              authorName,
              publications,
              (current, total, candidateName) => {
                const shortName =
                  candidateName.length > 30
                    ? candidateName.substring(0, 30) + "..."
                    : candidateName;
                updateStatus(
                  `DBLP 匹配中 (${current}/${total}): ${shortName}`
                );
              }
            );
            if (picked?.pid) {
              // 导入阶段拉取该 DBLP 作者的全部论文
              const dblpPubs = await fetchDblpAuthorPublications(picked.pid);
              const merged = mergePublicationsKeepUnique(
                publications,
                dblpPubs
              );
              publicationsData = merged;
              const ps = getTableState("publications");
              if (ps) ps.rows = publicationsToRows(merged);
              savePublications(merged);
              scheduleFullRender("publications");
              updateCollapseUI(doc);
              updateStatus(
                `DBLP 已补充论文：新增 ${Math.max(
                  0,
                  merged.length - publications.length
                )} 篇（总计 ${merged.length} 篇）`
              );
            } else {
              updateStatus("DBLP 未找到可自动确认的作者（无标题重合）");
            }
          }
        } catch (e) {
          ztoolkit.log("DBLP 补充失败:", e);
        }
      } catch (e: any) {
        updateStatus(`获取失败: ${e.message || "未知错误"}`);
      }
    });

  // ========== LLM 配置保存 ==========
  doc
    .querySelector(`#zotero-prefpane-${config.addonRef}-save-llm-config`)
    ?.addEventListener("command", () => {
      const providerSelect = doc.querySelector(
        `#zotero-prefpane-${config.addonRef}-llm-provider`
      ) as HTMLSelectElement;
      const modelSelect = doc.querySelector(
        `#zotero-prefpane-${config.addonRef}-llm-model`
      ); // XUL menulist
      const apiKeyInput = doc.querySelector(
        `#zotero-prefpane-${config.addonRef}-llm-api-key`
      ) as HTMLInputElement;
      const baseUrlInput = doc.querySelector(
        `#zotero-prefpane-${config.addonRef}-llm-base-url`
      ) as HTMLInputElement;

      const provider = providerSelect?.value || 'deepseek';
      const model = getMenulistValue(modelSelect) || getDefaultModel(provider as any);
      const apiKey = apiKeyInput?.value?.trim() || '';
      const baseUrl = baseUrlInput?.value?.trim() || '';

      setPref("llmProvider" as any, provider);
      setPref("llmModel" as any, model);
      setPref("llmApiKey" as any, apiKey);
      setPref("llmBaseUrl" as any, baseUrl);

      const statusEl = doc.querySelector(`#zotero-prefpane-${config.addonRef}-llm-status`) as HTMLElement;
      if (statusEl) {
        statusEl.textContent = 'OK! Config saved';
        statusEl.style.color = 'green';
        setTimeout(() => {
          statusEl.textContent = '';
        }, 3000);
      }
    });

  // ========== LLM 测试连接 ==========
  doc
    .querySelector(`#zotero-prefpane-${config.addonRef}-test-llm`)
    ?.addEventListener("command", async () => {
      const providerSelect = doc.querySelector(
        `#zotero-prefpane-${config.addonRef}-llm-provider`
      ) as HTMLSelectElement;
      const modelSelect = doc.querySelector(
        `#zotero-prefpane-${config.addonRef}-llm-model`
      ); // XUL menulist
      const apiKeyInput = doc.querySelector(
        `#zotero-prefpane-${config.addonRef}-llm-api-key`
      ) as HTMLInputElement;
      const baseUrlInput = doc.querySelector(
        `#zotero-prefpane-${config.addonRef}-llm-base-url`
      ) as HTMLInputElement;
      const statusEl = doc.querySelector(`#zotero-prefpane-${config.addonRef}-llm-status`) as HTMLElement;

      const provider = (providerSelect?.value || 'deepseek') as 'deepseek' | 'openai' | 'google' | 'claude' | 'openai-compatible';
      const model = getMenulistValue(modelSelect) || getDefaultModel(provider);
      const apiKey = apiKeyInput?.value?.trim() || '';
      const baseUrl = baseUrlInput?.value?.trim() || '';

      if (!apiKey) {
        statusEl.textContent = 'Error: API Key required';
        statusEl.style.color = 'red';
        return;
      }

      // 显示测试中状态
      statusEl.textContent = 'Testing connection...';
      statusEl.style.color = '#666';

      try {
        // 动态导入 LLMService
        const { LLMService } = await import('./llmService');

        const llmService = new LLMService({ provider, apiKey, baseUrl, model });

        // 发送一个简单的测试请求
        const result = await llmService.chat('Hello, please reply "OK"', 'You are a helpful AI assistant. Reply briefly.');

        if (result.content) {
          statusEl.textContent = 'OK! Connection successful';
          statusEl.style.color = 'green';
        } else {
          statusEl.textContent = 'Warning: Empty response';
          statusEl.style.color = 'orange';
        }
      } catch (e: any) {
        ztoolkit.log('LLM Test failed:', e);
        // 安全错误展示：只用 ASCII 字符，避免非 ASCII 导致 textContent 抛 TypeError
        const errMsg = (e.message || 'Unknown error').replace(/[^\x20-\x7E]/g, '?');
        statusEl.textContent = `Error: ${errMsg}`;
        statusEl.style.color = 'red';
      }
    });

  // ========== 获取模型列表 ==========
  doc
    .querySelector(`#zotero-prefpane-${config.addonRef}-fetch-models`)
    ?.addEventListener("command", async () => {
      const providerSelect = doc.querySelector(
        `#zotero-prefpane-${config.addonRef}-llm-provider`
      ) as HTMLSelectElement;
      const modelSelect = doc.querySelector(
        `#zotero-prefpane-${config.addonRef}-llm-model`
      ); // XUL menulist
      const apiKeyInput = doc.querySelector(
        `#zotero-prefpane-${config.addonRef}-llm-api-key`
      ) as HTMLInputElement;
      const baseUrlInput = doc.querySelector(
        `#zotero-prefpane-${config.addonRef}-llm-base-url`
      ) as HTMLInputElement;
      const statusEl = doc.querySelector(`#zotero-prefpane-${config.addonRef}-llm-status`) as HTMLElement;
      const fetchBtn = doc.querySelector(
        `#zotero-prefpane-${config.addonRef}-fetch-models`
      ) as any;

      const provider = (providerSelect?.value || 'deepseek') as 'deepseek' | 'openai' | 'google' | 'claude' | 'openai-compatible';
      const apiKey = apiKeyInput?.value?.trim() || '';
      const baseUrl = baseUrlInput?.value?.trim() || '';
      const savedModel = (getPref("llmModel" as any) as string) || getDefaultModel(provider);

      if (!apiKey) {
        if (statusEl) { statusEl.textContent = 'Error: API Key required'; statusEl.style.color = 'red'; }
        return;
      }

      if (statusEl) { statusEl.textContent = 'Fetching models...'; statusEl.style.color = '#666'; }
      if (fetchBtn) fetchBtn.disabled = true;

      try {
        const { fetchAvailableModels } = await import('./llmService');
        const models = await fetchAvailableModels(provider, apiKey, baseUrl || undefined);

        if (!modelSelect) return;

        // 清空现有选项并填充新模型列表（使用 XUL menulist API）
        clearMenulistPopup(modelSelect);
        
        for (const m of models) {
          addMenuItemToMenulist(modelSelect, m, m);
        }

        // 如果已保存的模型不在列表中，追加为自定义选项
        if (savedModel && !models.includes(savedModel)) {
          addMenuItemToMenulist(modelSelect, `${savedModel} (custom)`, savedModel);
        }
        
        // 追加"手动输入..."选项
        addMenuItemToMenulist(modelSelect, '-- 手动输入其他模型名 --', '__manual_input__');

        // 重新绑定事件监听器（因为清空了 popup）
        attachModelSelectChangeListener(modelSelect);

        // 优先恢复已保存的模型或选择第一个
        if (savedModel && models.includes(savedModel)) {
          setMenulistValue(modelSelect, savedModel);
        } else if (models.length > 0) {
          setMenulistValue(modelSelect, models[0]);
        } else {
          setMenulistValue(modelSelect, '');
        }

        if (statusEl) {
          statusEl.textContent = `OK! Got ${models.length} models`;
          statusEl.style.color = 'green';
          setTimeout(() => { statusEl.textContent = ''; }, 4000);
        }
      } catch (e: any) {
        ztoolkit.log('Failed to fetch model list:', e);
        if (statusEl) {
          // 安全错误展示：只用 ASCII 字符，避免非 ASCII 导致 textContent 抛 TypeError
          const errMsg = (e.message || 'Unknown error').replace(/[^\x20-\x7E]/g, '?');
          statusEl.textContent = `Error: ${errMsg}`;
          statusEl.style.color = 'red';
        }
      } finally {
        if (fetchBtn) fetchBtn.disabled = false;
      }
    });

  // 保存作者信息按钮
  doc
    .querySelector(`#zotero-prefpane-${config.addonRef}-save-author-info`)
    ?.addEventListener("command", () => {
      const info = getAuthorInfoFromForm(doc);
      saveAuthorInfoToPrefs(info);
      updateStatus("作者信息已保存");
    });

  // 添加论文按钮
  doc
    .querySelector(`#zotero-prefpane-${config.addonRef}-add-paper`)
    ?.addEventListener("command", () => {
      showAddPaperDialog((newPub) => {
        publicationsData.push(newPub);

        const state = getTableState("publications");
        if (state) {
          state.rows.push({
            title: newPub.title,
            year: newPub.year || "",
            venue: newPub.venue || "",
            detail: newPub.doi || "",
          });
        }

        savePublications(publicationsData);

        const tableHelper = getTableState("publications")?.tableHelper;
        if (tableHelper) {
          tableHelper.render();
        }

        updateStatus("论文添加成功");
        updateCollapseUI(doc);
      });
    });

  // 删除选中按钮
  doc
    .querySelector(`#zotero-prefpane-${config.addonRef}-delete-selected`)
    ?.addEventListener("command", () => {
      deleteSelectedRows("publications");
    });

  // 推荐相关论文/作者
  doc
    .querySelector(`#zotero-prefpane-${config.addonRef}-recommend`)
    ?.addEventListener("command", () => {
      showRecommendDialog();
    });

  // AI 推荐（偏好页：基于作者信息和论文，用 DeepSeek 打开对话窗口）
  doc
    .querySelector(`#zotero-prefpane-${config.addonRef}-author-ai`)
    ?.addEventListener("command", () => {
      showPrefsAIChat(doc);
    });

  // 一键生成简历
  doc
    .querySelector(`#zotero-prefpane-${config.addonRef}-generate-resume`)
    ?.addEventListener("command", () => {
      showResumeDialog(doc);
    });

  // 折叠/展开按钮
  const togglePairs: [TableKey, string][] = [
    ["publications", "toggle-pubs"],
    ["patents", "toggle-patents"],
    ["datasets", "toggle-datasets"],
    ["projects", "toggle-projects"],
  ];
  for (const [key, suffix] of togglePairs) {
    doc
      .querySelector(`#zotero-prefpane-${config.addonRef}-${suffix}`)
      ?.addEventListener("command", () => {
        toggleCollapse(key);
      });
  }

  // 添加专利按钮
  doc
    .querySelector(`#zotero-prefpane-${config.addonRef}-add-patent`)
    ?.addEventListener("command", () => {
      showAddRecordDialog(
        {
          titleLabel: "专利标题 *",
          venueLabel: "专利局/申请人",
          detailLabel: "专利号",
        },
        (record) => {
          const item: Patent = {
            title: record.title,
            year: record.year,
            office: record.venue,
            number: record.detail,
            url: record.detail ? `https://patents.google.com/patent/${record.detail}` : "",
          };
          patentsData.push(item);
          const state = getTableState("patents");
          if (state) {
            state.rows.push({
              title: item.title,
              year: item.year || "",
              venue: item.office || "",
              detail: item.number || "",
            });
          }
          savePatents(patentsData);
          refreshTable("patents");
          updateStatus("专利添加成功");
          updateCollapseUI(doc);
        }
      );
    });

  // 删除专利按钮
  doc
    .querySelector(`#zotero-prefpane-${config.addonRef}-delete-patent`)
    ?.addEventListener("command", () => {
      deleteSelectedRows("patents");
    });

  // 添加数据集按钮
  doc
    .querySelector(`#zotero-prefpane-${config.addonRef}-add-dataset`)
    ?.addEventListener("command", () => {
      showAddRecordDialog(
        {
          titleLabel: "数据集标题 *",
          venueLabel: "仓储/平台",
          detailLabel: "DOI/标识符",
          detailPlaceholder: "如：10.5281/zenodo.xxx",
        },
        (record) => {
          const item: Dataset = {
            title: record.title,
            year: record.year,
            repo: record.venue,
            doi: normalizeDoi(record.detail),
            url: record.detail ? `https://doi.org/${normalizeDoi(record.detail)}` : "",
          };
          datasetsData.push(item);
          const state = getTableState("datasets");
          if (state) {
            state.rows.push({
              title: item.title,
              year: item.year || "",
              venue: item.repo || "",
              detail: item.doi || "",
            });
          }
          saveDatasets(datasetsData);
          refreshTable("datasets");
          updateStatus("数据集添加成功");
          updateCollapseUI(doc);
        }
      );
    });

  // 删除数据集按钮
  doc
    .querySelector(`#zotero-prefpane-${config.addonRef}-delete-dataset`)
    ?.addEventListener("command", () => {
      deleteSelectedRows("datasets");
    });

  // 添加项目按钮
  doc
    .querySelector(`#zotero-prefpane-${config.addonRef}-add-project`)
    ?.addEventListener("command", () => {
      showAddRecordDialog(
        {
          titleLabel: "项目名称 *",
          venueLabel: "资助方/机构",
          detailLabel: "项目/资助号",
        },
        (record) => {
          const item: Project = {
            title: record.title,
            year: record.year,
            funder: record.venue,
            grantId: record.detail,
            url: record.detail ? record.detail : "",
          };
          projectsData.push(item);
          const state = getTableState("projects");
          if (state) {
            state.rows.push({
              title: item.title,
              year: item.year || "",
              venue: item.funder || "",
              detail: item.grantId || "",
            });
          }
          saveProjects(projectsData);
          refreshTable("projects");
          updateStatus("项目添加成功");
          updateCollapseUI(doc);
        }
      );
    });

  // 删除项目按钮
  doc
    .querySelector(`#zotero-prefpane-${config.addonRef}-delete-project`)
    ?.addEventListener("command", () => {
      deleteSelectedRows("projects");
    });

  // ---------------------------------------------------------
  // 新增：各模块刷新按钮事件
  // ---------------------------------------------------------

  // 刷新论文
  const refreshPubsBtn = doc.querySelector(`#zotero-prefpane-${config.addonRef}-refresh-publications`);
  if (!refreshPubsBtn) ztoolkit.log("未找到刷新论文按钮");
  refreshPubsBtn?.addEventListener("command", async () => {
    const orcid = orcidInput?.value?.trim();
    if (!orcid) {
      updateStatus("请输入 ORCID ID");
      return;
    }
    updateStatus("正在刷新论文...");
    ztoolkit.log("开始刷新论文, ORCID:", orcid);

    try {
      // 1. ORCID
      const publications = await fetchPublicationsFromOrcid(orcid);
      ztoolkit.log(`ORCID 返回论文数: ${publications.length}`);

      // 2. DBLP (基于 ORCID 获取到的信息)
      const info = await fetchAuthorInfoFromOrcid(orcid);
      let dblpPubs: Publication[] = [];
      const authorName = info.name?.trim();
      if (authorName) {
        const picked = await findFirstMatchingDblpAuthorByOverlap(
          authorName,
          publications,
          (current, total, candidateName) => {
            updateStatus(`DBLP 匹配中: ${candidateName}`);
          }
        );
        if (picked?.pid) {
          dblpPubs = await fetchDblpAuthorPublications(picked.pid);
          ztoolkit.log(`DBLP 返回论文数: ${dblpPubs.length}`);
        }
      }

      // 3. 合并 (ORCID + DBLP + 本地)
      let merged = mergePublicationsKeepUnique(publicationsData, publications);
      if (dblpPubs.length > 0) {
        merged = mergePublicationsKeepUnique(merged, dblpPubs);
      }

      publicationsData = merged;
      savePublications(merged);
      const pubState = getTableState("publications");
      if (pubState) pubState.rows = publicationsToRows(merged);
      refreshTable("publications");
      updateCollapseUI(doc);
      updateStatus(`论文刷新成功：当前共 ${merged.length} 篇`);

    } catch (e: any) {
      ztoolkit.log("论文刷新失败:", e);
      updateStatus(`刷新失败: ${e.message || e}`);
    }
  });

  // 刷新专利
  const refreshPatentBtn = doc.querySelector(`#zotero-prefpane-${config.addonRef}-refresh-patents`);
  if (!refreshPatentBtn) ztoolkit.log("未找到刷新专利按钮");
  refreshPatentBtn?.addEventListener("command", async () => {
    const orcid = orcidInput?.value?.trim();
    if (!orcid) {
      updateStatus("请输入 ORCID ID");
      return;
    }
    if (!checkExternalPluginAvailable("patent")) {
      updateStatus("未安装或未启用专利插件，无法刷新");
      ztoolkit.getGlobal("alert")("未检测到可用的专利查询插件 (Zotero.MyPublicationsExtensions.patent)");
      return;
    }
    updateStatus("正在刷新专利...");
    ztoolkit.log("开始刷新专利...");
    try {
      const items = await fetchPatentsFromExternalPlugin(orcid);
      ztoolkit.log(`外部插件返回专利数: ${items.length}`);
      // 保持合并逻辑
      const merged = mergePatents(patentsData, items);
      patentsData = merged;
      savePatents(merged);
      const state = getTableState("patents");
      if (state) state.rows = patentsToRows(merged);
      refreshTable("patents");
      updateCollapseUI(doc);
      updateStatus(`专利刷新成功：新增 ${items.length} 条，当前共 ${merged.length} 条`);
    } catch (e: any) {
      ztoolkit.log("专利刷新失败:", e);
      updateStatus(`刷新失败: ${e.message || e}`);
    }
  });

  // 刷新数据集 (重新展示)
  const refreshDatasetBtn = doc.querySelector(`#zotero-prefpane-${config.addonRef}-refresh-datasets`);
  if (!refreshDatasetBtn) ztoolkit.log("未找到刷新数据集按钮");
  refreshDatasetBtn?.addEventListener("command", async () => {
    const orcid = orcidInput?.value?.trim();
    if (!orcid) {
      updateStatus("请输入 ORCID ID");
      return;
    }
    if (!checkExternalPluginAvailable("dataset")) {
      updateStatus("未安装或未启用数据集插件，无法刷新");
      ztoolkit.getGlobal("alert")("未检测到可用的数据集查询插件 (Zotero.MyPublicationsExtensions.dataset)");
      return;
    }
    updateStatus("正在刷新数据集...");
    ztoolkit.log("开始刷新数据集...");
    try {
      const items = await fetchDatasetsFromExternalPlugin(orcid);
      ztoolkit.log(`外部插件返回数据集数: ${items.length}`);
      // 重新展示（覆盖）
      datasetsData = items;
      saveDatasets(items);
      const state = getTableState("datasets");
      if (state) state.rows = datasetsToRows(items);
      refreshTable("datasets");
      updateCollapseUI(doc);
      updateStatus(`数据集刷新成功：已获取 ${items.length} 条数据`);
    } catch (e: any) {
      ztoolkit.log("数据集刷新失败:", e);
      updateStatus(`刷新失败: ${e.message || e}`);
    }
  });

  // 刷新项目
  const refreshProjectBtn = doc.querySelector(`#zotero-prefpane-${config.addonRef}-refresh-projects`);
  if (!refreshProjectBtn) ztoolkit.log("未找到刷新项目按钮");
  refreshProjectBtn?.addEventListener("command", async () => {
    const orcid = orcidInput?.value?.trim();
    if (!orcid) {
      updateStatus("请输入 ORCID ID");
      return;
    }
    if (!checkExternalPluginAvailable("project")) {
      updateStatus("未安装或未启用项目插件，无法刷新");
      ztoolkit.getGlobal("alert")("未检测到可用的项目查询插件 (Zotero.MyPublicationsExtensions.project)");
      return;
    }
    updateStatus("正在刷新项目...");
    ztoolkit.log("开始刷新项目...");
    try {
      const items = await fetchProjectsFromExternalPlugin(orcid);
      ztoolkit.log(`外部插件返回项目数: ${items.length}`);
      // 保持合并逻辑
      const merged = mergeProjects(projectsData, items);
      projectsData = merged;
      saveProjects(merged);
      const state = getTableState("projects");
      if (state) state.rows = projectsToRows(merged);
      refreshTable("projects");
      updateCollapseUI(doc);
      updateStatus(`项目刷新成功：新增 ${items.length} 条，当前共 ${merged.length} 条`);
    } catch (e: any) {
      ztoolkit.log("项目刷新失败:", e);
      updateStatus(`刷新失败: ${e.message || e}`);
    }
  });

  // 一键导入按钮
  doc
    .querySelector(`#zotero-prefpane-${config.addonRef}-import-all`)
    ?.addEventListener("command", async () => {
      if (publicationsData.length === 0) {
        updateStatus("没有可导入的论文");
        return;
      }

      updateStatus("正在导入...");

      try {
        const result = await importToMyPublications(
          publicationsData,
          (current, total, title) => {
            const shortTitle =
              title.length > 30 ? title.substring(0, 30) + "..." : title;
            updateStatus(`正在导入 (${current}/${total}): ${shortTitle}`);
          }
        );

        let message = `导入完成！成功 ${result.successCount} 篇`;
        if (result.pdfCount > 0) {
          message += `，下载 ${result.pdfCount} 个 PDF`;
        }
        if (result.existedCount > 0) {
          message += `，已有 ${result.existedCount} 篇已在库中`;
        }
        if (result.skipCount > 0) {
          message += `，跳过 ${result.skipCount} 篇重复记录`;
        }
        if (result.failCount > 0) {
          message += `，失败 ${result.failCount} 篇`;
        }

        updateStatus(message);

        new ztoolkit.ProgressWindow(config.addonName)
          .createLine({
            text: message,
            type: "success",
            progress: 100,
          })
          .show();
      } catch (e: any) {
        updateStatus(`导入失败: ${e.message || "未知错误"}`);
      }
    });
}

// ==================== Phase 3: 知识库初始化面板 ====================

/**
 * 在偏好设置页面添加知识库初始化面板
 * 用户可以上传 CV/个人信息文档或填写个人主页 URL，一键导入到后端知识库
 */
function initKnowledgeBasePanel(win: Window) {
  const doc = win.document;

  // 在 LLM 配置区域之后、作者信息区域之前插入知识库面板
  // 查找 LLM 配置面板的容器
  const llmSection = doc.getElementById(`zotero-prefpane-${config.addonRef}-llm-settings`);
  if (!llmSection) {
    ztoolkit.log("[KB] 未找到 LLM 设置区域，跳过知识库面板初始化");
    return;
  }

  // 创建知识库面板容器（XUL vbox）
  const kbPanel = doc.createElementNS("http://www.mozilla.org/keymaster/gatekeeper/there.is.only.xul", "vbox") as XUL.Element;
  kbPanel.setAttribute("id", `${config.addonRef}-kb-panel`);

  // 用 DOM API 构建 XUL 结构
  const NS = "http://www.mozilla.org/keymaster/gatekeeper/there.is.only.xul";

  const groupbox = doc.createElementNS(NS, "groupbox");
  groupbox.setAttribute("style", "margin-top: 12px; margin-bottom: 0;");

  const caption = doc.createElementNS(NS, "caption");
  caption.setAttribute("label", "📚 知识库初始化（Agent 填表用）");

  const descEl = doc.createElementNS(NS, "description") as XUL.Element;
  descEl.setAttribute("style", "margin: 4px 0 8px 0; color: #666;");
  descEl.textContent = "上传个人信息文档（CV/个人简介），Agent 填表时将自动查询此知识库。个人主页自动从上方「作者信息」区域读取。";

  // 上传文件行
  const hboxUpload = doc.createElementNS(NS, "hbox") as XUL.Element;
  hboxUpload.setAttribute("align", "center");
  hboxUpload.setAttribute("style", "margin-top: 6px;");

  const lblUpload = doc.createElementNS(NS, "label") as XUL.Element;
  lblUpload.setAttribute("value", "上传个人信息文档：");
  lblUpload.setAttribute("style", "width: 140px;");

  const btnUpload = doc.createElementNS(NS, "button") as XUL.Element;
  btnUpload.setAttribute("id", `${config.addonRef}-kb-upload-btn`);
  btnUpload.setAttribute("label", "📂 选择文件");

  const lblFileName = doc.createElementNS(NS, "label") as XUL.Element;
  lblFileName.setAttribute("id", `${config.addonRef}-kb-file-name`);
  lblFileName.setAttribute("value", "");
  lblFileName.setAttribute("style", "color: #666; margin-left: 8px;");

  hboxUpload.appendChild(lblUpload);
  hboxUpload.appendChild(btnUpload);
  hboxUpload.appendChild(lblFileName);

  // 导入按钮行
  const hboxImport = doc.createElementNS(NS, "hbox") as XUL.Element;
  hboxImport.setAttribute("align", "center");
  hboxImport.setAttribute("style", "margin-top: 8px;");

  const btnImport = doc.createElementNS(NS, "button") as XUL.Element;
  btnImport.setAttribute("id", `${config.addonRef}-kb-init-btn`);
  btnImport.setAttribute("label", "🚀 导入知识库");
  btnImport.setAttribute("style", "padding: 6px 16px; font-weight: bold;");

  const lblStatus = doc.createElementNS(NS, "label") as XUL.Element;
  lblStatus.setAttribute("id", `${config.addonRef}-kb-status`);
  lblStatus.setAttribute("value", "");
  lblStatus.setAttribute("style", "color: #666; margin-left: 12px;");

  hboxImport.appendChild(btnImport);
  hboxImport.appendChild(lblStatus);

  // 提示
  const descTip = doc.createElementNS(NS, "description") as XUL.Element;
  descTip.setAttribute("style", "margin-top: 4px; font-size: 11px; color: #999;");
  descTip.textContent = "提示：确保后端服务（localhost:8000）已启动。";

  // 组装
  groupbox.appendChild(caption);
  groupbox.appendChild(descEl);
  groupbox.appendChild(hboxUpload);
  groupbox.appendChild(hboxImport);
  groupbox.appendChild(descTip);
  kbPanel.appendChild(groupbox);

  // 插入到 LLM 配置面板之后
  llmSection.parentNode?.insertBefore(kbPanel, llmSection.nextSibling);

  // 绑定事件
  let selectedKbFile: nsIFile | null = null;
  const serverUrl = (getPref("serverUrl" as any) as string) || "http://zotero-fill.local:8001";

  // 文件选择按钮
  const uploadBtn = doc.getElementById(`${config.addonRef}-kb-upload-btn`);
  const fileNameLabel = doc.getElementById(`${config.addonRef}-kb-file-name`);
  uploadBtn?.addEventListener("click", () => {
    const fp = Components.classes["@mozilla.org/filepicker;1"].createInstance(
      Components.interfaces.nsIFilePicker
    );
    fp.init(win, "选择个人信息文档", Components.interfaces.nsIFilePicker.modeOpen);
    fp.appendFilter("Word 文档", "*.docx");
    fp.appendFilter("PDF 文件", "*.pdf");
    fp.appendFilter("所有文件", "*.*");

    fp.open((rv) => {
      if (rv === Components.interfaces.nsIFilePicker.returnOK && fp.file) {
        selectedKbFile = fp.file;
        if (fileNameLabel) {
          fileNameLabel.setAttribute("value", `✅ ${fp.file.leafName}`);
        }
      }
    });
  });

  // 导入按钮
  const initBtn = doc.getElementById(`${config.addonRef}-kb-init-btn`);
  const statusLabel = doc.getElementById(`${config.addonRef}-kb-status`);

  initBtn?.addEventListener("click", async () => {
    if (initBtn) initBtn.setAttribute("disabled", "true");
    if (statusLabel) statusLabel.setAttribute("value", "⏳ 正在导入...");

    try {
      const fileName = selectedKbFile.leafName || "document";
      const ext = fileName.split(".").pop()?.toLowerCase() || "";

      const isBinaryFile = ["pdf", "docx", "doc"].includes(ext);

      const requestBody: Record<string, any> = {
        source: fileName,
        doc_type: "cv",
        title: fileName,
        chunk_size: 500,
        chunk_overlap: 100,
      };

      if (isBinaryFile) {
        // PDF/DOCX: 以 Base64 上传，后端负责提取文本
        if (statusLabel) statusLabel.setAttribute("value", "⏳ 正在读取文件...");
        const fileBase64 = await readFileAsBase64Simple(selectedKbFile);
        if (!fileBase64) {
          throw new Error("文件读取失败");
        }
        requestBody.file_base64 = fileBase64;
        if (statusLabel) statusLabel.setAttribute("value", "⏳ 正在上传并提取文本...");
      } else {
        // 纯文本文件: 直接传 content
        if (statusLabel) statusLabel.setAttribute("value", "⏳ 正在读取文件...");
        const fileContent = await readFileAsText(selectedKbFile);
        if (!fileContent.trim()) {
          throw new Error("文件内容为空");
        }
        requestBody.content = fileContent;
      }

      // 调用后端 /kb/import/document
      const resp = await fetch(`${serverUrl}/kb/import/document`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(requestBody),
      });

      if (!resp.ok) {
        throw new Error(`HTTP ${resp.status}: ${await resp.text()}`);
      }

      const result = await resp.json() as any;

      if (result.success) {
        const extra = result.extracted_chars ? ` (提取 ${result.extracted_chars} 字符)` : "";
        const msg = `✅ 导入成功！${result.chunks || 0} 个文档块已索引${extra}`;
        if (statusLabel) statusLabel.setAttribute("value", msg);

        new ztoolkit.ProgressWindow(config.addonName)
          .createLine({ text: msg, type: "success", progress: 100 })
          .show();

        // ── 自动解析 CV：提取结构化数据导入知识库 ──
        try {
          if (statusLabel) statusLabel.setAttribute("value", "⏳ 正在用 AI 解析 CV，提取结构化数据...");

          const { getLLMConfig } = await import("./llmService");
          const llmConfig = getLLMConfig();

          // 检查 LLM 配置是否可用
          if (!llmConfig.apiKey && !llmConfig.baseUrl) {
            ztoolkit.log("[KB] LLM 未配置，跳过 CV 结构化解析");
          } else {
            // 使用与 Agent 相同的 LLM 配置格式
            const parsePayload: Record<string, any> = {
              llm_config: {
                model: llmConfig.model || "deepseek-chat",
                api_key: llmConfig.apiKey || "",
                base_url: llmConfig.baseUrl || "",
                temperature: 0.1,
              },
            };

            if (isBinaryFile) {
              // 二进制文件：传 file_base64，后端负责提取文本
              parsePayload.file_base64 = requestBody.file_base64;
              parsePayload.source = fileName;
            } else {
              // 纯文本：直接传 content
              parsePayload.content = requestBody.content;
            }

            const parseResp = await fetch(`${serverUrl}/kb/import/parse_cv`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify(parsePayload),
            });

            if (parseResp.ok) {
              const parseResult = await parseResp.json() as any;
              if (parseResult.success) {
                if (statusLabel) {
                  statusLabel.setAttribute("value", `✅ ${parseResult.message}`);
                }
                new ztoolkit.ProgressWindow(config.addonName)
                  .createLine({
                    text: `CV 结构化解析: ${parseResult.message}`,
                    type: "success",
                    progress: 100,
                  })
                  .show();
                ztoolkit.log("[KB] CV 结构化解析结果:", parseResult.results);
              } else {
                ztoolkit.log("[KB] CV 结构化解析失败:", parseResult.error);
                if (statusLabel) {
                  statusLabel.setAttribute("value", `⚠️ CV 结构化解析失败: ${parseResult.error}`);
                }
              }
            } else {
              ztoolkit.log("[KB] CV 结构化解析 HTTP 错误:", parseResp.status);
            }
          }
        } catch (parseErr: any) {
          // 解析失败不影响主流程（文档已成功导入）
          ztoolkit.log("[KB] CV 结构化解析异常:", parseErr);
          if (statusLabel) {
            statusLabel.setAttribute("value", `⚠️ CV 结构化解析出错: ${parseErr.message || "未知错误"}`);
          }
        }
      } else {
        throw new Error(result.error || "导入失败");
      }
    } catch (e: any) {
      const errMsg = `❌ 导入失败: ${e.message || "未知错误"}`;
      if (statusLabel) statusLabel.setAttribute("value", errMsg);

      new ztoolkit.ProgressWindow(config.addonName)
        .createLine({ text: errMsg, type: "error", progress: 100 })
        .show();

      ztoolkit.log("[KB] 导入失败:", e);
    } finally {
      if (initBtn) initBtn.removeAttribute("disabled");
    }
  });
}

/**
 * 读取文件为 Base64（用于 PDF/DOCX 等二进制文件上传）
 * 使用 XPCOM binary stream 读取，确保二进制安全
 */
async function readFileAsBase64Simple(file: nsIFile): Promise<string> {
  return new Promise((resolve, reject) => {
    try {
      const fileStream = Components.classes[
        "@mozilla.org/network/file-input-stream;1"
      ].createInstance(Components.interfaces.nsIFileInputStream);
      fileStream.init(file, 0x01, 0, null);

      const binaryStream = Components.classes[
        "@mozilla.org/binaryinputstream;1"
      ].createInstance(Components.interfaces.nsIBinaryInputStream);
      binaryStream.setInputStream(fileStream);

      const available = binaryStream.available();
      const bytes = binaryStream.readBytes(available);
      binaryStream.close();
      fileStream.close();

      // 将二进制字符串转为 Base64
      let binary = "";
      for (let i = 0; i < bytes.length; i++) {
        binary += String.fromCharCode(bytes.charCodeAt(i));
      }
      resolve(btoa(binary));
    } catch (e) {
      reject(e);
    }
  });
}

/**
 * 读取文件为 UTF-8 纯文本（用于知识库导入）
 */
async function readFileAsText(file: nsIFile): Promise<string> {
  // 方式1: Zotero.File（推荐）
  if (typeof Zotero !== "undefined" && (Zotero as any).File?.getContentsAsync) {
    try {
      return await (Zotero as any).File.getContentsAsync(file, "UTF-8");
    } catch (e) {
      ztoolkit.log("[KB] Zotero.File 读取失败:", e);
    }
  }

  // 方式2: NetUtil.asyncFetch
  return new Promise((resolve, reject) => {
    try {
      const fileURI = Services.io.newFileURI(file);
      NetUtil.asyncFetch(fileURI, (inputStream: any, status: number) => {
        if (!Components.isSuccessCode(status)) {
          reject(new Error(`NetUtil fetch failed: ${status}`));
          return;
        }
        try {
          const data = NetUtil.readInputStreamToString(inputStream, inputStream.available());
          inputStream.close();
          resolve(data);
        } catch (e2) {
          reject(e2);
        }
      });
    } catch (e) {
      reject(e);
    }
  });
}