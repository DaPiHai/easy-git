import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { Inbox } from 'lucide-react';
import { Badge } from './Badge';
import { EmptyState } from './EmptyState';

describe('Badge', () => {
  it('renders neutral by default', () => {
    render(<Badge>3</Badge>);
    expect(screen.getByText('3')).toHaveClass('bg-surface-2');
  });

  it('renders the count variant with primary fill', () => {
    render(<Badge variant="count">12</Badge>);
    expect(screen.getByText('12')).toHaveClass('bg-primary');
  });

  it('renders semantic variants with tinted backgrounds', () => {
    render(<Badge variant="modified">M</Badge>);
    expect(screen.getByText('M')).toHaveClass('text-git-modified');
  });
});

describe('EmptyState', () => {
  it('shows title, description and optional action', () => {
    render(
      <EmptyState
        icon={Inbox}
        title="空空如也"
        description="这里还没有内容"
        action={<button type="button">去打开</button>}
      />,
    );
    expect(screen.getByText('空空如也')).toBeInTheDocument();
    expect(screen.getByText('这里还没有内容')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '去打开' })).toBeInTheDocument();
  });
});
