import type { ToolDefinition } from '../tool-types';

type Token =
  | { type: 'number'; value: number }
  | { type: 'operator'; value: '+' | '-' | '*' | '/' }
  | { type: 'leftParen' }
  | { type: 'rightParen' };

type StackOperator = '+' | '-' | '*' | '/' | '(';

function tokenizeExpression(expression: string): Token[] {
  const tokens: Token[] = [];
  let index = 0;

  while (index < expression.length) {
    const char = expression[index];

    if (/\s/.test(char)) {
      index += 1;
      continue;
    }

    if (/[0-9.]/.test(char)) {
      let end = index + 1;
      while (end < expression.length && /[0-9.]/.test(expression[end])) end += 1;

      const raw = expression.slice(index, end);
      if ((raw.match(/\./g) ?? []).length > 1) {
        throw new Error(`Invalid number "${raw}"`);
      }

      const value = Number(raw);
      if (!Number.isFinite(value)) {
        throw new Error(`Invalid number "${raw}"`);
      }

      tokens.push({ type: 'number', value });
      index = end;
      continue;
    }

    if (char === '(') {
      tokens.push({ type: 'leftParen' });
      index += 1;
      continue;
    }

    if (char === ')') {
      tokens.push({ type: 'rightParen' });
      index += 1;
      continue;
    }

    if (char === '+' || char === '*' || char === '/') {
      tokens.push({ type: 'operator', value: char });
      index += 1;
      continue;
    }

    if (char === '-') {
      const previous = tokens.at(-1);
      const isUnary = !previous || previous.type === 'operator' || previous.type === 'leftParen';

      if (isUnary) {
        tokens.push({ type: 'number', value: 0 });
      }

      tokens.push({ type: 'operator', value: '-' });
      index += 1;
      continue;
    }

    throw new Error(`Unsupported character "${char}"`);
  }

  return tokens;
}

function precedence(operator: '+' | '-' | '*' | '/'): number {
  return operator === '+' || operator === '-' ? 1 : 2;
}

function applyOperator(values: number[], operator: '+' | '-' | '*' | '/'): void {
  if (values.length < 2) throw new Error('Malformed expression');

  const right = values.pop() as number;
  const left = values.pop() as number;

  switch (operator) {
    case '+':
      values.push(left + right);
      return;
    case '-':
      values.push(left - right);
      return;
    case '*':
      values.push(left * right);
      return;
    case '/':
      if (right === 0) throw new Error('Division by zero');
      values.push(left / right);
      return;
  }
}

function evaluateExpression(expression: string): number {
  const tokens = tokenizeExpression(expression);
  const values: number[] = [];
  const operators: StackOperator[] = [];

  for (const token of tokens) {
    if (token.type === 'number') {
      values.push(token.value);
      continue;
    }

    if (token.type === 'leftParen') {
      operators.push('(');
      continue;
    }

    if (token.type === 'rightParen') {
      while (operators.length && operators.at(-1) !== '(') {
        applyOperator(values, operators.pop() as '+' | '-' | '*' | '/');
      }

      if (operators.pop() !== '(') {
        throw new Error('Mismatched parentheses');
      }

      continue;
    }

    while (
      operators.length &&
      operators.at(-1) !== '(' &&
      precedence(operators.at(-1) as '+' | '-' | '*' | '/') >= precedence(token.value)
    ) {
      applyOperator(values, operators.pop() as '+' | '-' | '*' | '/');
    }

    operators.push(token.value);
  }

  while (operators.length) {
    const operator = operators.pop();
    if (operator === '(') throw new Error('Mismatched parentheses');
    applyOperator(values, operator as '+' | '-' | '*' | '/');
  }

  if (values.length !== 1 || !Number.isFinite(values[0])) {
    throw new Error('Malformed expression');
  }

  return values[0];
}

export const calculateExpressionTool: ToolDefinition = {
  name: 'calculate_expression',
  description: 'Evaluates arithmetic expressions with numbers, parentheses, and + - * / operators.',
  directReturn: true,
  readonly: true,
  parameters: {
    expression: {
      type: 'string',
      description: 'An arithmetic expression such as (2 + 3) * 4 / 5.',
    },
  },
  execute: async ({ params }) => {
    const input = String(params.expression ?? '').trim();
    if (!input) throw new Error('Expression must not be empty');
    const result = evaluateExpression(input);

    return {
      expression: input,
      result,
      displayText: `${input} = ${String(result)}`,
    };
  },
};
