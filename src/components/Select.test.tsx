import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { Select } from './Select';

function openMenu(testId: string) {
  fireEvent.click(screen.getByTestId(testId));
}

const options = [
  { value: 'origin', label: 'origin' },
  { value: 'mirror', label: 'mirror' },
];

describe('Select', () => {
  it('shows the selected label and reports menu choices', async () => {
    const onChange = vi.fn();
    render(
      <Select
        value="origin"
        options={options}
        onChange={onChange}
        ariaLabel="远端"
        testId="pick"
      />,
    );

    expect(screen.getByTestId('pick')).toHaveTextContent('origin');
    openMenu('pick');
    expect(screen.getByTestId('pick-option-origin')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('pick-option-mirror'));
    expect(onChange).toHaveBeenCalledWith('mirror');
  });

  it('keeps disabled triggers closed and shows a placeholder', async () => {
    render(
      <Select
        value=""
        options={options}
        onChange={vi.fn()}
        ariaLabel="远端"
        testId="pick"
        placeholder="请选择"
        disabled
      />,
    );

    expect(screen.getByTestId('pick')).toHaveTextContent('请选择');
    expect(screen.getByTestId('pick')).toBeDisabled();
    openMenu('pick');
    expect(screen.queryByTestId('pick-option-origin')).not.toBeInTheDocument();
  });

  it('opens with the keyboard and closes with Escape', () => {
    render(
      <Select value="origin" options={options} onChange={vi.fn()} ariaLabel="远端" testId="pick" />,
    );

    fireEvent.keyDown(screen.getByTestId('pick'), { key: 'ArrowDown' });
    expect(screen.getByTestId('pick-option-origin')).toBeInTheDocument();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByTestId('pick-option-origin')).not.toBeInTheDocument();
  });

  it('renders an empty state when there are no options', async () => {
    render(
      <Select
        value=""
        options={[]}
        onChange={vi.fn()}
        ariaLabel="远端"
        testId="pick"
        emptyLabel="暂无选项"
      />,
    );

    openMenu('pick');
    expect(screen.getByText('暂无选项')).toBeInTheDocument();
  });
});
