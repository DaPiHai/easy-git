import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';
import { ThemeToggle } from './ThemeToggle';
import { THEME_MODE_STORAGE_KEY, useUiStore } from '../../stores/uiStore';

beforeEach(() => {
  localStorage.clear();
  document.documentElement.dataset.theme = '';
  useUiStore.setState({ themeMode: 'system', systemPrefersDark: false, resolvedTheme: 'dark' });
});

describe('ThemeToggle', () => {
  it('renders a radiogroup with the three modes', () => {
    render(<ThemeToggle />);
    const group = screen.getByRole('radiogroup', { name: '切换主题' });
    expect(group).toBeInTheDocument();
    for (const label of ['跟随系统', '亮色', '暗色']) {
      expect(screen.getByRole('radio', { name: label })).toBeInTheDocument();
    }
  });

  it('applies and persists the chosen mode', async () => {
    render(<ThemeToggle />);
    await userEvent.click(screen.getByTestId('theme-light'));
    expect(document.documentElement.dataset.theme).toBe('light');
    expect(localStorage.getItem(THEME_MODE_STORAGE_KEY)).toBe('light');
    expect(screen.getByRole('radio', { name: '亮色' })).toHaveAttribute('aria-checked', 'true');

    await userEvent.click(screen.getByTestId('theme-dark'));
    expect(document.documentElement.dataset.theme).toBe('dark');
  });
});
