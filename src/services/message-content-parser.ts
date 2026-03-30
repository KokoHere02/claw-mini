export type FeishuPostNode = {
  tag?: string;
  text?: string;
  href?: string;
  image_key?: string;
  user_id?: string;
  user_name?: string;
  emoji_type?: string;
};

type FeishuPostLocale = {
  title?: string;
  content?: FeishuPostNode[][];
};

type FeishuPostPayload =
  | FeishuPostNode[][]
  | FeishuPostLocale
  | Record<string, FeishuPostNode[][] | FeishuPostLocale>;

export type ParsedMessageContent = {
  text: string;
  imageKeys: string[];
  files: Array<{
    fileKey: string;
    fileName?: string;
  }>;
};

function parseTextContent(content: string): ParsedMessageContent {
  const prop = JSON.parse(content) as { text?: string };
  return {
    text: prop.text?.trim() || '',
    imageKeys: [],
    files: [],
  };
}

function parseImageContent(content: string): ParsedMessageContent {
  const prop = JSON.parse(content) as { image_key?: string };
  return {
    text: '',
    imageKeys: prop.image_key ? [prop.image_key] : [],
    files: [],
  };
}

function parseFileContent(content: string): ParsedMessageContent {
  const prop = JSON.parse(content) as { file_key?: string; file_name?: string };
  return {
    text: '',
    imageKeys: [],
    files: prop.file_key
      ? [
          {
            fileKey: prop.file_key,
            fileName: prop.file_name,
          },
        ]
      : [],
  };
}

function isParagraphList(value: unknown): value is FeishuPostNode[][] {
  return Array.isArray(value);
}

function isPostLocale(value: unknown): value is FeishuPostLocale {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

export function parsePostContent(content: string): ParsedMessageContent {
  const payload = JSON.parse(content) as FeishuPostPayload | null;
  if (!payload || typeof payload !== 'object') {
    return { text: '', imageKeys: [], files: [] };
  }

  let title = '';
  let paragraphs: FeishuPostNode[][] = [];

  if (isParagraphList(payload)) {
    paragraphs = payload;
  } else if (isPostLocale(payload)) {
    title = payload.title?.trim() || '';
    paragraphs = payload.content ?? [];
  } else {
    const post = Object.values(payload).find((value) => {
      return isParagraphList(value) || (isPostLocale(value) && Array.isArray(value.content));
    });

    if (!post) {
      return { text: '', imageKeys: [], files: [] };
    }

    if (isParagraphList(post)) {
      paragraphs = post;
    } else {
      title = post.title?.trim() || '';
      paragraphs = post.content ?? [];
    }
  }

  const lines: string[] = [];
  const imageKeys: string[] = [];

  if (title) {
    lines.push(title);
  }

  for (const paragraph of paragraphs) {
    if (!Array.isArray(paragraph)) continue;

    const text = paragraph
      .map((node) => {
        switch (node.tag) {
          case 'text':
            return node.text ?? '';
          case 'a':
            return node.text?.trim() || node.href || '';
          case 'at':
            return node.user_name?.trim() || node.text?.trim() || (node.user_id ? `@${node.user_id}` : '@mention');
          case 'img':
            if (node.image_key) {
              imageKeys.push(node.image_key);
            }
            return '[image]';
          case 'media':
            return '[media]';
          case 'emotion':
            return node.emoji_type ? `[emoji:${node.emoji_type}]` : '[emoji]';
          case 'code_block':
            return node.text ? `\n${node.text}\n` : '';
          case 'hr':
            return '---';
          default:
            return node.text ?? '';
        }
      })
      .join('')
      .trim();

    if (text) {
      lines.push(text);
    }
  }

  return {
    text: lines.join('\n').trim(),
    imageKeys,
    files: [],
  };
}

export function extractMessageContent(messageType: string, content: string): ParsedMessageContent {
  if (messageType === 'text') return parseTextContent(content);
  if (messageType === 'post') return parsePostContent(content);
  if (messageType === 'image') return parseImageContent(content);
  if (messageType === 'file') return parseFileContent(content);
  return { text: '', imageKeys: [], files: [] };
}
