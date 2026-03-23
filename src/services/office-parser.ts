import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

function decodeXmlEntities(value: string): string {
  return value
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

function extractWordXmlText(xml: string): string {
  const normalized = xml
    .replace(/<w:tab\b[^/]*\/>/g, '\t')
    .replace(/<w:br\b[^/]*\/>/g, '\n')
    .replace(/<w:cr\b[^/]*\/>/g, '\n')
    .replace(/<\/w:p>/g, '\n')
    .replace(/<w:t\b[^>]*>/g, '')
    .replace(/<\/w:t>/g, '')
    .replace(/<[^>]+>/g, '');

  return decodeXmlEntities(normalized)
    .replace(/\r\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

async function expandArchive(sourcePath: string, destinationPath: string): Promise<void> {
  const command = [
    '-NoProfile',
    '-Command',
    [
      "Add-Type -AssemblyName System.IO.Compression.FileSystem",
      `[System.IO.Compression.ZipFile]::ExtractToDirectory('${sourcePath.replace(/'/g, "''")}', '${destinationPath.replace(/'/g, "''")}')`,
    ].join('; '),
  ];

  await execFileAsync('powershell.exe', command, { windowsHide: true });
}

async function saveWordDocumentAsUnicodeText(sourcePath: string, targetPath: string): Promise<void> {
  const script = [
    '$word = $null',
    '$document = $null',
    'try {',
    '  $word = New-Object -ComObject Word.Application',
    '  $word.Visible = $false',
    '  $word.DisplayAlerts = 0',
    `  $document = $word.Documents.Open('${sourcePath.replace(/'/g, "''")}', $false, $true)`,
    `  $document.SaveAs2('${targetPath.replace(/'/g, "''")}', 7)`,
    '} finally {',
    '  if ($document -ne $null) { $document.Close($false) }',
    '  if ($word -ne $null) { $word.Quit() }',
    '}',
  ].join('; ');

  await execFileAsync('powershell.exe', ['-NoProfile', '-Command', script], { windowsHide: true });
}

function decodeTextFile(buffer: Uint8Array): string {
  if (buffer.length >= 2) {
    if (buffer[0] === 0xff && buffer[1] === 0xfe) {
      return new TextDecoder('utf-16le', { fatal: false }).decode(buffer).trim();
    }
    if (buffer[0] === 0xfe && buffer[1] === 0xff) {
      const swapped = new Uint8Array(buffer.length - 2);
      for (let i = 2; i + 1 < buffer.length; i += 2) {
        swapped[i - 2] = buffer[i + 1];
        swapped[i - 1] = buffer[i];
      }
      return new TextDecoder('utf-16le', { fatal: false }).decode(swapped).trim();
    }
  }

  return new TextDecoder('utf-8', { fatal: false }).decode(buffer).trim();
}

export async function extractDocxText(data: Uint8Array, filename = 'document.docx'): Promise<string> {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'claw-docx-'));
  const archivePath = path.join(tempRoot, filename);
  const expandedPath = path.join(tempRoot, 'expanded');

  try {
    await fs.writeFile(archivePath, data);
    await expandArchive(archivePath, expandedPath);

    const wordDir = path.join(expandedPath, 'word');
    const candidateFiles = [
      path.join(wordDir, 'document.xml'),
    ];

    try {
      const names = await fs.readdir(wordDir);
      for (const name of names) {
        if (name.startsWith('header') && name.endsWith('.xml')) {
          candidateFiles.push(path.join(wordDir, name));
        }
        if (name.startsWith('footer') && name.endsWith('.xml')) {
          candidateFiles.push(path.join(wordDir, name));
        }
      }
    } catch {
      // Ignore missing optional header/footer files.
    }

    const parts: string[] = [];
    for (const file of candidateFiles) {
      try {
        const xml = await fs.readFile(file, 'utf8');
        const text = extractWordXmlText(xml);
        if (text) {
          parts.push(text);
        }
      } catch {
        // Ignore files that are not present.
      }
    }

    return parts.join('\n\n').trim();
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true }).catch(() => {});
  }
}

export async function extractDocText(data: Uint8Array, filename = 'document.doc'): Promise<string> {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'claw-doc-'));
  const sourcePath = path.join(tempRoot, filename);
  const targetPath = path.join(tempRoot, 'document.txt');

  try {
    await fs.writeFile(sourcePath, data);
    await saveWordDocumentAsUnicodeText(sourcePath, targetPath);
    const textBuffer = await fs.readFile(targetPath);
    return decodeTextFile(textBuffer);
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true }).catch(() => {});
  }
}
