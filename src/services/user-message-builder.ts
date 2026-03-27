import type { ModelMessage } from 'ai';
import path from 'node:path';
import { USER_FACING_TEXT } from '@/constants/user-facing-text';
import { downloadMessageFile, downloadMessageImage } from '@/services/feishu';
import { extractDocText, extractDocxText } from './office-parser';
import type { ParsedMessageContent } from './message-content';

export class UnsupportedAttachmentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UnsupportedAttachmentError';
  }
}

function isPdfFile(mediaType?: string, filename?: string): boolean {
  return mediaType === 'application/pdf' || path.extname(filename || '').toLowerCase() === '.pdf';
}

function isOfficeDocument(mediaType?: string, filename?: string): boolean {
  const ext = path.extname(filename || '').toLowerCase();
  return (
    ext === '.ppt' ||
    ext === '.pptx' ||
    ext === '.xls' ||
    ext === '.xlsx' ||
    mediaType === 'application/vnd.ms-powerpoint' ||
    mediaType === 'application/vnd.openxmlformats-officedocument.presentationml.presentation' ||
    mediaType === 'application/vnd.ms-excel' ||
    mediaType === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
  );
}

function isDocFile(mediaType?: string, filename?: string): boolean {
  const ext = path.extname(filename || '').toLowerCase();
  return ext === '.doc' || mediaType === 'application/msword';
}

function isDocxFile(mediaType?: string, filename?: string): boolean {
  const ext = path.extname(filename || '').toLowerCase();
  return (
    ext === '.docx' ||
    mediaType === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
  );
}

function isTextLikeFile(mediaType?: string, filename?: string): boolean {
  const ext = path.extname(filename || '').toLowerCase();
  return (
    !!mediaType?.startsWith('text/') ||
    mediaType === 'application/json' ||
    mediaType === 'application/xml' ||
    mediaType === 'text/xml' ||
    mediaType === 'application/javascript' ||
    mediaType === 'application/typescript' ||
    mediaType === 'application/x-sh' ||
    mediaType === 'application/csv' ||
    ext === '.txt' ||
    ext === '.md' ||
    ext === '.json' ||
    ext === '.csv' ||
    ext === '.xml' ||
    ext === '.html' ||
    ext === '.css' ||
    ext === '.js' ||
    ext === '.ts' ||
    ext === '.py' ||
    ext === '.java' ||
    ext === '.c' ||
    ext === '.cpp' ||
    ext === '.go' ||
    ext === '.sh'
  );
}

function formatAttachmentLabel(fileName: string | undefined, fallback: string): string {
  const value = fileName?.trim();
  return value || fallback;
}

function unsupportedAttachmentMessage(fileName: string | undefined, detail: string): string {
  return `暂不支持文件“${formatAttachmentLabel(fileName, '未知文件')}”。${detail}`;
}

export async function buildUserMessage(
  messageType: string,
  messageId: string,
  content: ParsedMessageContent,
): Promise<ModelMessage> {
  if (
    !['post', 'image', 'file'].includes(messageType) ||
    (!content.imageKeys.length && !content.files.length)
  ) {
    return {
      role: 'user',
      content: content.text,
    };
  }

  const promptText = content.text || USER_FACING_TEXT.attachmentPromptFallback;
  const parts: Array<
    | { type: 'text'; text: string }
    | { type: 'image'; image: Uint8Array; mediaType?: string }
    | { type: 'file'; data: Uint8Array; mediaType: string; filename?: string }
  > = [{ type: 'text', text: promptText }];

  const images = await Promise.all(
    content.imageKeys.map(async (imageKey) => {
      const image = await downloadMessageImage(messageId, imageKey);
      return {
        type: 'image' as const,
        image: image.data,
        mediaType: image.mediaType,
      };
    }),
  );

  const files = await Promise.all(
    content.files.map(async (file) => {
      const downloaded = await downloadMessageFile(messageId, file.fileKey);
      const mediaType = downloaded.mediaType || 'application/octet-stream';

      if (isDocFile(mediaType, file.fileName)) {
        let text = '';
        try {
          text = await extractDocText(downloaded.data, file.fileName || 'document.doc');
        } catch (error) {
          throw new UnsupportedAttachmentError(
            unsupportedAttachmentMessage(
              file.fileName,
              `无法从 .doc 提取可读文本：${error instanceof Error ? error.message : String(error)}`,
            ),
          );
        }

        if (!text) {
          throw new UnsupportedAttachmentError(
            unsupportedAttachmentMessage(file.fileName, '已解析 .doc，但未提取到可读文本。'),
          );
        }

        return {
          type: 'text' as const,
          text: file.fileName ? `[file:${file.fileName}]\n${text}` : text,
        };
      }

      if (isDocxFile(mediaType, file.fileName)) {
        let text = '';
        try {
          text = await extractDocxText(downloaded.data, file.fileName || 'document.docx');
        } catch (error) {
          throw new UnsupportedAttachmentError(
            unsupportedAttachmentMessage(
              file.fileName,
              `无法从 .docx 提取可读文本：${error instanceof Error ? error.message : String(error)}`,
            ),
          );
        }

        if (!text) {
          throw new UnsupportedAttachmentError(
            unsupportedAttachmentMessage(file.fileName, '已解析 .docx，但未提取到可读文本。'),
          );
        }

        return {
          type: 'text' as const,
          text: file.fileName ? `[file:${file.fileName}]\n${text}` : text,
        };
      }

      if (isOfficeDocument(mediaType, file.fileName)) {
        throw new UnsupportedAttachmentError(
          unsupportedAttachmentMessage(file.fileName, '暂未实现该 Office 文档类型的直接解析。'),
        );
      }

      if (isTextLikeFile(mediaType, file.fileName)) {
        const text = new TextDecoder('utf-8', { fatal: false }).decode(downloaded.data).trim();
        return {
          type: 'text' as const,
          text: file.fileName ? `[file:${file.fileName}]\n${text}` : text,
        };
      }

      if (isPdfFile(mediaType, file.fileName)) {
        return {
          type: 'file' as const,
          data: downloaded.data,
          mediaType,
          filename: file.fileName,
        };
      }

      throw new UnsupportedAttachmentError(
        unsupportedAttachmentMessage(
          file.fileName || mediaType,
          '当前仅支持文本类文件和 PDF。',
        ),
      );
    }),
  );

  parts.push(...images);
  parts.push(...files);

  return {
    role: 'user',
    content: parts,
  };
}
