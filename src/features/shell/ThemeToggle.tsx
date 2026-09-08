import { Monitor, Moon, Sun } from 'lucide-react';
import { t } from '../../lib/i18n';
import { useUiStore, type ThemeMode } from '../../stores/uiStore';

const options: { mode: ThemeMode; icon: typeof Sun; labelKey: Parameters<typeof t>[0] }[] = [
  { mode: 'system', icon: Monitor, labelKey: 'theme.system' },
  { mode: 'light', icon: Sun, labelKey: 'theme.light' },
  { mode: 'dark', icon: Moon, labelKey: 'theme.dark' },
];

/** Segmented theme control (UI doc §6.1 sizing, F-02): follow-system / light / dark. */
export function ThemeToggle() {
  const themeMode = useUiStore((s) => s.themeMode);
  const setThemeMode = useUiStore((s) => s.setThemeMode);

  return (
    <div
      role="radiogroup"
      aria-label={t('theme.toggle')}
      className="flex h-6 items-center gap-0.5 rounded-md border border-hairline bg-surface-1 p-0.5"
      data-testid="theme-toggle"
    >
      {options.map(({ mode, icon: Icon, labelKey }) => {
        const active = themeMode === mode;
        return (
          <button
            key={mode}
            type="button"
            role="radio"
            aria-checked={active}
            aria-label={t(labelKey)}
            title={t(labelKey)}
            data-testid={`theme-${mode}`}
            onClick={() => setThemeMode(mode)}
            className={`flex size-5 items-center justify-center rounded-[5px] transition-colors duration-80 ease-eg ${
              active ? 'bg-surface-2 text-ink' : 'text-ink-subtle hover:text-ink-muted'
            }`}
          >
            <Icon className="size-3.5" aria-hidden />
          </button>
        );
      })}
    </div>
  );
}
