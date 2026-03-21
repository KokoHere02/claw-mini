export type ToolParameterType = 'string' | 'number' | 'boolean';

export type ToolParameterDefinition = {
  type: ToolParameterType;
  description: string;
  optional?: boolean;
};

export type ToolParameters = Record<string, ToolParameterDefinition>;

export type ToolDefinition = {
  name: string;
  description: string;
  parameters: ToolParameters;
  execute: (params: Record<string, unknown>) => Promise<unknown>;
  timeoutMs?: number;
};

export type ToolSummary = {
  name: string;
  description: string;
  parameters: ToolParameters;
};
