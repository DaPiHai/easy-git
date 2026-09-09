import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';
import { ConceptCards } from './ConceptCards';

beforeEach(() => {
  localStorage.clear();
});

describe('ConceptCards (F-11 / X-04)', () => {
  it('shows the four concept cards on first run', () => {
    render(<ConceptCards />);
    expect(screen.getByTestId('concept-cards')).toBeInTheDocument();
    expect(screen.getByText('暂存区')).toBeInTheDocument();
    expect(screen.getByText('提交')).toBeInTheDocument();
    expect(screen.getByText('分支')).toBeInTheDocument();
    expect(screen.getByText('远端与同步')).toBeInTheDocument();
  });

  it('persists dismissal and stays hidden afterwards', async () => {
    const user = userEvent.setup();
    const { unmount } = render(<ConceptCards />);
    await user.click(screen.getByTestId('concept-cards-dismiss'));
    expect(screen.queryByTestId('concept-cards')).not.toBeInTheDocument();
    expect(localStorage.getItem('eg.onboard.concepts')).toBe('done');
    unmount();
    render(<ConceptCards />);
    expect(screen.queryByTestId('concept-cards')).not.toBeInTheDocument();
  });

  it('does not render once the flag is set', () => {
    localStorage.setItem('eg.onboard.concepts', 'done');
    render(<ConceptCards />);
    expect(screen.queryByTestId('concept-cards')).not.toBeInTheDocument();
  });
});
