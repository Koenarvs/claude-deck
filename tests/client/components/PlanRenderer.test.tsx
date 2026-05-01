import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { PlanRenderer } from '../../../src/components/goal/PlanRenderer';
import type { PlanTodo } from '../../../src/shared/types';

// ── Tests ────────────────────────────────────────────────────────────────────

describe('PlanRenderer', () => {
  it('renders empty state when no todos', () => {
    render(<PlanRenderer todos={[]} />);

    expect(screen.getByTestId('plan-empty')).toBeInTheDocument();
    expect(screen.getByText('No plan items yet')).toBeInTheDocument();
  });

  it('renders single todo with content', () => {
    const todos: PlanTodo[] = [
      { content: 'Write tests', status: 'pending', priority: 1, children: [] },
    ];
    render(<PlanRenderer todos={todos} />);

    expect(screen.getByTestId('plan-renderer')).toBeInTheDocument();
    expect(screen.getByText('Write tests')).toBeInTheDocument();
  });

  it('renders todos with correct status test IDs', () => {
    const todos: PlanTodo[] = [
      { content: 'Done', status: 'completed', priority: 1, children: [] },
      { content: 'Working', status: 'in_progress', priority: 2, children: [] },
      { content: 'Waiting', status: 'pending', priority: 3, children: [] },
    ];
    render(<PlanRenderer todos={todos} />);

    expect(screen.getByTestId('plan-todo-completed')).toBeInTheDocument();
    expect(screen.getByTestId('plan-todo-in_progress')).toBeInTheDocument();
    expect(screen.getByTestId('plan-todo-pending')).toBeInTheDocument();
  });

  it('renders progress bar with correct percentages', () => {
    const todos: PlanTodo[] = [
      { content: 'A', status: 'completed', priority: 1, children: [] },
      { content: 'B', status: 'completed', priority: 2, children: [] },
      { content: 'C', status: 'in_progress', priority: 3, children: [] },
      { content: 'D', status: 'pending', priority: 4, children: [] },
    ];
    render(<PlanRenderer todos={todos} />);

    expect(screen.getByText('2/4 (50%)')).toBeInTheDocument();
  });

  it('renders 100% when all are complete', () => {
    const todos: PlanTodo[] = [
      { content: 'A', status: 'completed', priority: 1, children: [] },
      { content: 'B', status: 'completed', priority: 2, children: [] },
    ];
    render(<PlanRenderer todos={todos} />);

    expect(screen.getByText('2/2 (100%)')).toBeInTheDocument();
  });

  it('renders 0% when none are complete', () => {
    const todos: PlanTodo[] = [
      { content: 'A', status: 'pending', priority: 1, children: [] },
      { content: 'B', status: 'in_progress', priority: 2, children: [] },
    ];
    render(<PlanRenderer todos={todos} />);

    expect(screen.getByText('0/2 (0%)')).toBeInTheDocument();
  });

  it('renders nested children', () => {
    const todos: PlanTodo[] = [
      {
        content: 'Parent',
        status: 'in_progress',
        priority: 1,
        children: [
          { content: 'Child 1', status: 'completed', priority: 1, children: [] },
          { content: 'Child 2', status: 'pending', priority: 2, children: [] },
        ],
      },
    ];
    render(<PlanRenderer todos={todos} />);

    expect(screen.getByText('Parent')).toBeInTheDocument();
    expect(screen.getByText('Child 1')).toBeInTheDocument();
    expect(screen.getByText('Child 2')).toBeInTheDocument();
  });

  it('counts nested children in progress calculation', () => {
    const todos: PlanTodo[] = [
      {
        content: 'Parent',
        status: 'in_progress',
        priority: 1,
        children: [
          { content: 'Child 1', status: 'completed', priority: 1, children: [] },
          { content: 'Child 2', status: 'completed', priority: 2, children: [] },
        ],
      },
    ];
    render(<PlanRenderer todos={todos} />);

    // 2 completed out of 3 total (parent + 2 children)
    expect(screen.getByText('2/3 (67%)')).toBeInTheDocument();
  });

  it('renders deeply nested children', () => {
    const todos: PlanTodo[] = [
      {
        content: 'Level 0',
        status: 'in_progress',
        priority: 1,
        children: [
          {
            content: 'Level 1',
            status: 'in_progress',
            priority: 1,
            children: [
              { content: 'Level 2', status: 'completed', priority: 1, children: [] },
            ],
          },
        ],
      },
    ];
    render(<PlanRenderer todos={todos} />);

    expect(screen.getByText('Level 0')).toBeInTheDocument();
    expect(screen.getByText('Level 1')).toBeInTheDocument();
    expect(screen.getByText('Level 2')).toBeInTheDocument();
    // 1 completed / 3 total
    expect(screen.getByText('1/3 (33%)')).toBeInTheDocument();
  });

  it('applies strikethrough to completed todo text', () => {
    const todos: PlanTodo[] = [
      { content: 'Done task', status: 'completed', priority: 1, children: [] },
    ];
    render(<PlanRenderer todos={todos} />);

    const element = screen.getByText('Done task');
    expect(element.className).toContain('line-through');
  });

  it('does not apply strikethrough to pending todo text', () => {
    const todos: PlanTodo[] = [
      { content: 'Not done', status: 'pending', priority: 1, children: [] },
    ];
    render(<PlanRenderer todos={todos} />);

    const element = screen.getByText('Not done');
    expect(element.className).not.toContain('line-through');
  });

  it('does not apply strikethrough to in_progress todo text', () => {
    const todos: PlanTodo[] = [
      { content: 'In progress', status: 'in_progress', priority: 1, children: [] },
    ];
    render(<PlanRenderer todos={todos} />);

    const element = screen.getByText('In progress');
    expect(element.className).not.toContain('line-through');
  });

  it('renders status icons with correct aria-labels', () => {
    const todos: PlanTodo[] = [
      { content: 'A', status: 'completed', priority: 1, children: [] },
      { content: 'B', status: 'in_progress', priority: 2, children: [] },
      { content: 'C', status: 'pending', priority: 3, children: [] },
    ];
    render(<PlanRenderer todos={todos} />);

    expect(screen.getByLabelText('Completed')).toBeInTheDocument();
    expect(screen.getByLabelText('In progress')).toBeInTheDocument();
    expect(screen.getByLabelText('Pending')).toBeInTheDocument();
  });

  it('renders many items correctly', () => {
    const todos: PlanTodo[] = Array.from({ length: 20 }, (_, i) => ({
      content: `Task ${i + 1}`,
      status: i < 10 ? 'completed' as const : 'pending' as const,
      priority: i + 1,
      children: [],
    }));
    render(<PlanRenderer todos={todos} />);

    expect(screen.getByText('10/20 (50%)')).toBeInTheDocument();
    expect(screen.getByText('Task 1')).toBeInTheDocument();
    expect(screen.getByText('Task 20')).toBeInTheDocument();
  });
});
