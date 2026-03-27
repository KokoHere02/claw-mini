import type { ToolDefinition } from '../tool-types';

export const getCurrentTimeTool: ToolDefinition = {
  name: 'get_current_time',
  description: 'Returns the current server time and an ISO timestamp.',
  directReturn: true,
  readonly: true,
  parameters: {
    timeZone: {
      type: 'string',
      description: 'Optional IANA timezone like Asia/Shanghai or America/New_York.',
      optional: true,
    },
  },
  execute: async ({ params }) => {
    const now = new Date();
    const requestedZone =
      typeof params.timeZone === 'string' && params.timeZone.trim() ? params.timeZone.trim() : undefined;

    const formatted = new Intl.DateTimeFormat('en-US', {
      dateStyle: 'full',
      timeStyle: 'long',
      timeZone: requestedZone,
    }).format(now);

    return {
      iso: now.toISOString(),
      formatted,
      timeZone: requestedZone ?? 'server-default',
      displayText: requestedZone
        ? `当前时间（${requestedZone}）: ${formatted}`
        : `当前时间: ${formatted}`,
    };
  },
};
