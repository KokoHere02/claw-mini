export type ToolParameterType = 'string' | 'number' | 'boolean';

export type ToolParameterDefinition = {
  type: ToolParameterType;
  description: string;
  optional?: boolean;
};

export type ToolParameters = Record<string, ToolParameterDefinition>;

export type ToolExecuteInput = {
  params: Record<string, unknown>;
  signal?: AbortSignal;
};

export type ToolDefinition = {
  name: string;
  description: string;
  parameters: ToolParameters;
  execute: (input: ToolExecuteInput) => Promise<unknown>;
  timeoutMs?: number;
  directReturn?: boolean;
  readonly?: boolean;
};

export type ToolSummary = {
  name: string;
  description: string;
  parameters: ToolParameters;
};
