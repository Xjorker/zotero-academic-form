// database.ts

// 初始化数据库
export async function initDatabase() {
    try {
        // 作者信息
        await Zotero.DB.queryAsync(`
    CREATE TABLE IF NOT EXISTS academic_form_person (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      orcid TEXT,
      name TEXT,
      affiliation TEXT,
      country TEXT,
      keywords TEXT,
      biography TEXT,
      website TEXT,
      customFields TEXT,
      updated_at TEXT
    )
  `);

        // 项目
        await Zotero.DB.queryAsync(`
    CREATE TABLE IF NOT EXISTS academic_form_projects (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT,
      year TEXT,
      funder TEXT,
      grantId TEXT,
      url TEXT,
      type TEXT,
      updated_at TEXT
    )
  `);

        // 专利
        await Zotero.DB.queryAsync(`
    CREATE TABLE IF NOT EXISTS academic_form_patents (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT,
      year TEXT,
      office TEXT,
      number TEXT,
      url TEXT,
      type TEXT,
      updated_at TEXT
    )
  `);

        // 数据集
        await Zotero.DB.queryAsync(`
    CREATE TABLE IF NOT EXISTS academic_form_datasets (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT,
      year TEXT,
      repo TEXT,
      doi TEXT,
      url TEXT,
      type TEXT,
      updated_at TEXT
    )
  `);
        await debugDump();

        Zotero.debug("[AcademicForm] 数据库初始化完成 ✅");
    } catch (err) {
        Zotero.debug(`[AcademicForm] 数据库初始化失败 ❌: ${String(err)}`);
    }
}

// database.ts - 修正版

// ============================ 作者 ============================
export async function saveAuthor(info: any) {
    await Zotero.DB.queryAsync(`DELETE FROM academic_form_person`);

    await Zotero.DB.queryAsync(
        `INSERT INTO academic_form_person
      (orcid, name, affiliation, country, keywords, biography, website, customFields, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))`,
        [
            info.orcid ?? "",
            info.name ?? "",
            info.affiliation ?? "",
            info.country ?? "",
            info.keywords ?? "",
            info.biography ?? "",
            info.website ?? "",
            JSON.stringify(info.customFields ?? []),
        ]
    );

    Zotero.debug("[AcademicForm] 作者数据库保存成功 ✅");
}

export async function getAuthor() {
    const rows = await Zotero.DB.queryAsync(`
    SELECT * FROM academic_form_person LIMIT 1
  `);

    if (!rows || !rows.length) return null;

    const r = rows[0];

    return {
        id: r.id,
        orcid: r.orcid,
        name: r.name,
        affiliation: r.affiliation,
        country: r.country,
        keywords: r.keywords,
        biography: r.biography,
        website: r.website,
        customFields: r.customFields ? JSON.parse(r.customFields) : []
    };
}

// ============================ 项目 ============================
export async function saveProjects_sql(projects: any[]) {
    await Zotero.DB.queryAsync(`DELETE FROM academic_form_projects`);

    for (const p of projects) {
        await Zotero.DB.queryAsync(
            `INSERT INTO academic_form_projects
       (title, year, funder, grantId, url, type, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, datetime('now'))`,
            [
                p.title ?? "",
                p.year ?? "",
                p.funder ?? "",
                p.grantId ?? "",
                p.url ?? "",
                p.type ?? "",
            ]
        );
    }

    Zotero.debug(`[AcademicForm] 项目数据库保存成功 ✅ 共 ${projects.length} 条`);
}

export async function getProjects_sql() {
    const rows = await Zotero.DB.queryAsync(`
    SELECT * FROM academic_form_projects
    ORDER BY year DESC
  `);

    return rows ?? [];
}

export async function deleteProject(id: number) {

    await Zotero.DB.queryAsync(
        `DELETE FROM academic_form_projects WHERE id=?`,
        [id]
    );

    Zotero.debug(`[AcademicForm] 删除项目 ${id} 成功`);
}

// ============================ 专利 ============================
export async function savePatents_sql(items: any[]) {
    await Zotero.DB.queryAsync(`DELETE FROM academic_form_patents`);

    for (const p of items) {
        await Zotero.DB.queryAsync(
            `INSERT INTO academic_form_patents
       (title, year, office, number, url, type, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, datetime('now'))`,
            [
                p.title ?? "",
                p.year ?? "",
                p.office ?? "",
                p.number ?? "",
                p.url ?? "",
                p.type ?? "",
            ]
        );
    }

    Zotero.debug(`[AcademicForm] 专利数据库保存成功 ✅ 共 ${items.length} 条`);
}

export async function getPatents() {

    const rows = await Zotero.DB.queryAsync(`
    SELECT * FROM academic_form_patents
    ORDER BY year DESC
  `);

    return rows ?? [];
}

export async function deletePatent(id: number) {

    await Zotero.DB.queryAsync(
        `DELETE FROM academic_form_patents WHERE id=?`,
        [id]
    );

    Zotero.debug(`[AcademicForm] 删除专利 ${id} 成功`);
}

// ============================ 数据集 ============================
export async function saveDatasets_sql(items: any[]) {
    await Zotero.DB.queryAsync(`DELETE FROM academic_form_datasets`);

    for (const d of items) {
        await Zotero.DB.queryAsync(
            `INSERT INTO academic_form_datasets
       (title, year, repo, doi, url, type, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, datetime('now'))`,
            [
                d.title ?? "",
                d.year ?? "",
                d.repo ?? "",
                d.doi ?? "",
                d.url ?? "",
                d.type ?? "",
            ]
        );
    }

    Zotero.debug(`[AcademicForm] 数据集数据库保存成功 ✅ 共 ${items.length} 条`);
}

export async function getDatasets() {

    const rows = await Zotero.DB.queryAsync(`
    SELECT * FROM academic_form_datasets
    ORDER BY year DESC
  `);

    return rows ?? [];
}

export async function deleteDataset(id: number) {

    await Zotero.DB.queryAsync(
        `DELETE FROM academic_form_datasets WHERE id=?`,
        [id]
    );

    Zotero.debug(`[AcademicForm] 删除数据集 ${id} 成功`);
}

// ============================ 调试输出 ============================
export async function debugDump() {
    const tables = [
        "academic_form_person",
        "academic_form_projects",
        "academic_form_patents",
        "academic_form_datasets",
    ];

    for (const t of tables) {
        const rows = await Zotero.DB.queryAsync(`SELECT * FROM "${t}"`);
        Zotero.debug(`[AcademicForm] ${t}`);
        Zotero.debug(rows);
    }
}



