import { Check, Save, UserRound } from 'lucide-react';
import { useEffect, useState } from 'react';
import { t } from '../../lib/i18n';
import { SHORTCUTS } from '../../lib/shortcuts';
import { useRepoStore } from '../../stores/repoStore';
import { useUiStore } from '../../stores/uiStore';
import { toast } from '../../stores/toastStore';
import { ThemeToggle } from '../shell/ThemeToggle';
import { LogsPanel } from './LogsPanel';

/**
 * Settings page v1 (m1-plan F-14, P1): Git identity (global config), theme
 * and the 简洁/专家 mode preference. Network & credentials sections land later.
 */
export function SettingsPage() {
  return (
    <div className="h-full overflow-y-auto" data-testid="settings-view">
      <div className="mx-auto max-w-[720px] px-eg-5 py-eg-5">
        <h1 className="text-title font-semibold text-ink">{t('settings.title')}</h1>
        <IdentitySection />
        <AppearanceSection />
        <ShortcutsSection />
        <LogsPanel />
      </div>
    </div>
  );
}

function SectionCard({
  title,
  desc,
  children,
  testId,
}: {
  title: string;
  desc?: string;
  children: React.ReactNode;
  testId: string;
}) {
  return (
    <section
      className="mt-eg-5 rounded-xl border border-hairline bg-surface-1 px-eg-5 py-eg-4"
      data-testid={testId}
    >
      <h2 className="text-section font-semibold text-ink">{title}</h2>
      {desc ? <p className="mt-0.5 text-caption text-ink-tertiary">{desc}</p> : null}
      <div className="mt-eg-3">{children}</div>
    </section>
  );
}

function IdentitySection() {
  const configGet = useRepoStore((s) => s.configGet);
  const configSet = useRepoStore((s) => s.configSet);
  const activeId = useRepoStore((s) => s.activeId);
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [loaded, setLoaded] = useState(false);
  const [saving, setSaving] = useState(false);

  // Global scope: identity is machine-level (repo-local overrides still win at
  // commit time; the commit box shows the effective identity warning).
  useEffect(() => {
    if (!activeId || loaded) return;
    void Promise.all([configGet('global', 'user.name'), configGet('global', 'user.email')]).then(
      ([storedName, storedEmail]) => {
        setName(storedName ?? '');
        setEmail(storedEmail ?? '');
        setLoaded(true);
      },
    );
  }, [activeId, loaded, configGet]);

  const save = () => {
    if (!name.trim() || !email.trim()) {
      toast.error(t('settings.identity.invalid'));
      return;
    }
    setSaving(true);
    void configSet('global', 'user.name', name.trim())
      .then(() => configSet('global', 'user.email', email.trim()))
      .then(() => toast.success(t('settings.identity.saved')))
      .catch(() => toast.error(t('toast.actionFailed')))
      .finally(() => setSaving(false));
  };

  return (
    <SectionCard
      title={t('settings.identity')}
      desc={t('settings.identity.desc')}
      testId="settings-identity"
    >
      <div className="flex items-center gap-eg-4">
        <UserRound
          className="size-8 shrink-0 rounded-full bg-surface-2 p-1.5 text-ink-subtle"
          aria-hidden
        />
        <label className="flex min-w-0 flex-1 flex-col gap-1">
          <span className="text-caption text-ink-subtle">{t('settings.identity.name')}</span>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={t('settings.identity.name.placeholder')}
            data-testid="settings-name"
            className="h-8 rounded-md border border-hairline-strong bg-surface-2 px-eg-2 text-secondary text-ink outline-none placeholder:text-ink-tertiary focus:border-primary"
          />
        </label>
        <label className="flex min-w-0 flex-1 flex-col gap-1">
          <span className="text-caption text-ink-subtle">{t('settings.identity.email')}</span>
          <input
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder={t('settings.identity.email.placeholder')}
            data-testid="settings-email"
            className="h-8 rounded-md border border-hairline-strong bg-surface-2 px-eg-2 text-secondary text-ink outline-none placeholder:text-ink-tertiary focus:border-primary"
          />
        </label>
      </div>
      <div className="mt-eg-3 flex justify-end">
        <button
          type="button"
          data-testid="settings-save"
          disabled={!loaded || saving}
          onClick={save}
          className="flex h-8 items-center gap-1.5 rounded-md bg-primary px-3.5 text-secondary font-medium text-on-primary transition-opacity duration-80 ease-eg hover:opacity-90 disabled:pointer-events-none disabled:opacity-40"
        >
          <Save className="size-4" aria-hidden />
          {t('settings.identity.save')}
        </button>
      </div>
    </SectionCard>
  );
}

/** Shortcut cheat sheet (m1-plan X-03): bindings live in lib/shortcuts.ts. */
function ShortcutsSection() {
  return (
    <SectionCard title={t('settings.shortcuts')} testId="settings-shortcuts">
      <dl className="grid grid-cols-[auto_1fr] items-baseline gap-x-eg-4 gap-y-1.5">
        {SHORTCUTS.map((s) => (
          <div
            key={s.id}
            className="col-span-2 grid grid-cols-[auto_1fr] items-baseline gap-x-eg-4"
          >
            <dt className="min-w-24 rounded-md border border-hairline bg-surface-2 px-1.5 py-0.5 text-center font-mono text-mono text-ink-muted">
              {s.keys}
            </dt>
            <dd className="text-secondary text-ink-muted">{t(s.actionKey)}</dd>
          </div>
        ))}
      </dl>
    </SectionCard>
  );
}

function AppearanceSection() {
  const expertMode = useUiStore((s) => s.expertMode);
  const toggleExpertMode = useUiStore((s) => s.toggleExpertMode);

  return (
    <SectionCard title={t('settings.appearance')} testId="settings-appearance">
      <div className="flex items-center justify-between gap-eg-3">
        <span className="text-secondary text-ink-muted">{t('theme.toggle')}</span>
        <ThemeToggle />
      </div>
      <div className="mt-eg-3 flex items-center justify-between gap-eg-3">
        <span className="text-secondary text-ink-muted">{t('settings.mode')}</span>
        <ModeSwitch expertMode={expertMode} onToggle={toggleExpertMode} />
      </div>
      <p className="mt-eg-2 text-caption text-ink-tertiary">{t('settings.mode.desc')}</p>
    </SectionCard>
  );
}

function ModeSwitch({ expertMode, onToggle }: { expertMode: boolean; onToggle: () => void }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={expertMode}
      data-testid="mode-switch"
      onClick={onToggle}
      className={`relative h-5 w-9 rounded-full transition-colors duration-80 ease-eg ${
        expertMode ? 'bg-primary' : 'bg-surface-3'
      }`}
    >
      <span
        className={`absolute top-0.5 size-4 rounded-full bg-on-primary shadow-sm transition-transform duration-80 ease-eg ${
          expertMode ? 'translate-x-4.5' : 'translate-x-0.5'
        }`}
      >
        {expertMode ? <Check className="size-3 text-primary" aria-hidden /> : null}
      </span>
    </button>
  );
}
