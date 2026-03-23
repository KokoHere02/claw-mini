import type { ModelMessage } from 'ai';
import path from 'node:path';
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

  const promptText = content.text || 'Please analyze the user provided attachment and answer accordingly.';
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
            `Unsupported file type: ${file.fileName || 'doc file'}. Failed to extract readable text from the .doc file: ${error instanceof Error ? error.message : String(error)}`,
          );
        }

        if (!text) {
          throw new UnsupportedAttachmentError(
            `Unsupported file type: ${file.fileName || 'doc file'}. The .doc file was parsed but no readable text was extracted.`,
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
            `Unsupported file type: ${file.fileName || 'docx file'}. Failed to extract readable text from the .docx file: ${error instanceof Error ? error.message : String(error)}`,
          );
        }

        if (!text) {
          throw new UnsupportedAttachmentError(
            `Unsupported file type: ${file.fileName || 'docx file'}. The .docx file was parsed but no readable text was extracted.`,
          );
        }

        return {
          type: 'text' as const,
          text: file.fileName ? `[file:${file.fileName}]\n${text}` : text,
        };
      }

      if (isOfficeDocument(mediaType, file.fileName)) {
        throw new UnsupportedAttachmentError(
          `Unsupported file type: ${file.fileName || 'office document'}. Direct parsing for Office documents is not implemented yet.`,
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
        `Unsupported file type: ${file.fileName || mediaType}. Currently only text-like files and PDF are supported.`,
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
