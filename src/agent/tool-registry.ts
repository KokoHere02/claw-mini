import { builtInTools } from './tools';
import type { ToolDefinition, ToolSummary } from './tool-types';

export class ToolRegistry {
  constructor(private readonly tools: ToolDefinition[]) {}

  list(): ToolDefinition[] {
    return this.tools;
  }

  get(name: string): ToolDefinition | undefined {
    return this.tools.find((tool) => tool.name === name);
  }

  summary(): ToolSummary[] {
    return this.tools.map(({ name, description, parameters }) => ({
      name,
      description,
      parameters,
    }));
  }
}

export const registry = new ToolRegistry(builtInTools);
