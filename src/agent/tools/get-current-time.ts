import type { ToolDefinition } from '../tool-types';

export const getCurrentTimeTool: ToolDefinition = {
  name: 'get_current_time',
  description: 'Returns the current server time and an ISO timestamp.',
  parameters: {
    timeZone: {
      type: 'string',
      description: 'Optional IANA timezone like Asia/Shanghai or America/New_York.',
      optional: true,
    },
  },
  execute: async ({ timeZone }) => {
    const now = new Date();
    const requestedZone =
      typeof timeZone === 'string' && timeZone.trim() ? timeZone.trim() : undefined;

    const formatted = new Intl.DateTimeFormat('en-US', {
      dateStyle: 'full',
      timeStyle: 'long',
      timeZone: requestedZone,
    }).format(now);

    return {
      iso: now.toISOString(),
      formatted,
      timeZone: requestedZone ?? 'server-default',
    };
  },
};
