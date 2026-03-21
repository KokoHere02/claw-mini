import type { ToolDefinition } from '../tool-types';
import { calculateExpressionTool } from './calculate-expression';
import { getCurrentTimeTool } from './get-current-time';
import { httpRequestTool } from './http-request';
import { runCommandTool } from './run-command';

export const builtInTools: ToolDefinition[] = [
  getCurrentTimeTool,
  calculateExpressionTool,
  httpRequestTool,
  runCommandTool,
];
