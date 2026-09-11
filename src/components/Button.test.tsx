import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { Button } from './Button';

describe('Button', () => {
  it('renders its children', () => {
    render(<Button>提交</Button>);
    expect(screen.getByRole('button', { name: '提交' })).toBeInTheDocument();
  });

  it('invokes onClick when enabled', async () => {
    const onClick = vi.fn();
    render(<Button onClick={onClick}>确认</Button>);
    await userEvent.click(screen.getByRole('button'));
    expect(onClick).toHaveBeenCalledOnce();
  });

  it('does not invoke onClick when disabled', async () => {
    const onClick = vi.fn();
    render(
      <Button onClick={onClick} disabled>
        推送
      </Button>,
    );
    await userEvent.click(screen.getByRole('button'));
    expect(onClick).not.toHaveBeenCalled();
    expect(screen.getByRole('button')).toBeDisabled();
  });

  it('shows a spinner, keeps its label and blocks clicks while loading', async () => {
    const onClick = vi.fn();
    const { container } = render(
      <Button onClick={onClick} loading>
        推送
      </Button>,
    );
    expect(container.querySelector('svg.animate-spin')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '推送' })).toBeDisabled();
    await userEvent.click(screen.getByRole('button'));
    expect(onClick).not.toHaveBeenCalled();
  });
});
