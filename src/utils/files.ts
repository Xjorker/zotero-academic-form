// src/utils/file.ts
export async function downloadFile(
    url: string,
    fileName: string
): Promise<string> {
    const tmpDir = await Zotero.getTempDirectory();
    const filePath = PathUtils.join(tmpDir.path, fileName);

    const response = await fetch(url);
    if (!response.ok) {
        throw new Error(`Download failed: ${response.status}`);
    }

    const buffer = await response.arrayBuffer();

    await IOUtils.write(filePath, new Uint8Array(buffer));

    return filePath;
}
