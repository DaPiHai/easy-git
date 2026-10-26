import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { createPortal } from 'react-dom';
import { Check, ChevronDown } from 'lucide-react';

export interface SelectOption {
  value: string;
  label: string;
  disabled?: boolean;
}

export interface SelectProps {
  value: string;
  options: SelectOption[];
  onChange: (value: string) => void;
  ariaLabel: string;
  testId?: string;
  placeholder?: string;
  emptyLabel?: string;
  size?: 'sm' | 'md';
  tone?: 'surface-1' | 'surface-2';
  className?: string;
  disabled?: boolean;
}

const sizeClasses = {
  sm: 'h-7 px-2 text-caption',
  md: 'h-8 px-eg-2 text-secondary',
} as const;

const toneClasses = {
  'surface-1': 'bg-surface-1',
  'surface-2': 'bg-surface-2',
} as const;

/**
 * App-wide select (UI doc §6): a token-styled trigger + surface-3 menu.
 *
 * Deliberately a small controlled popover instead of a native <select> (its
 * OS popup ignores the app theme) or Radix RadioGroup (jsdom's focus/pointer
 * shims make the menu take ~20s to appear in tests). Keyboard support:
 * Enter/Space/ArrowDown opens, Arrow keys move, Enter/Space selects, Escape
 * closes; an outside pointerdown closes it.
 */
export function Select({
  value,
  options,
  onChange,
  ariaLabel,
  testId,
  placeholder = '',
  emptyLabel = '—',
  size = 'md',
  tone = 'surface-2',
  className = '',
  disabled = false,
}: SelectProps) {
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);
  const [position, setPosition] = useState<{
    left: number;
    top: number;
    width: number;
    up: boolean;
  } | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const optionRefs = useRef<Array<HTMLButtonElement | null>>([]);

  const selectedIndex = options.findIndex((option) => option.value === value);
  const selected = selectedIndex >= 0 ? options[selectedIndex] : null;

  const updatePosition = () => {
    const rect = triggerRef.current?.getBoundingClientRect();
    if (!rect) return;
    // Flip above the trigger when the menu would run off the viewport.
    const up = rect.bottom + 280 > window.innerHeight;
    setPosition({
      left: rect.left,
      top: up ? rect.top - 4 : rect.bottom + 4,
      width: rect.width,
      up,
    });
  };

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (!rootRef.current?.contains(target) && !menuRef.current?.contains(target)) {
        setOpen(false);
      }
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setOpen(false);
        triggerRef.current?.focus();
      }
    };
    const onFocusIn = (event: FocusEvent) => {
      const target = event.target as Node;
      if (!rootRef.current?.contains(target) && !menuRef.current?.contains(target)) {
        setOpen(false);
      }
    };
    const reposition = () => updatePosition();
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    document.addEventListener('focusin', onFocusIn);
    window.addEventListener('resize', reposition);
    window.addEventListener('scroll', reposition, true);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
      document.removeEventListener('focusin', onFocusIn);
      window.removeEventListener('resize', reposition);
      window.removeEventListener('scroll', reposition, true);
    };
  }, [open]);

  useEffect(() => {
    if (open) optionRefs.current[activeIndex]?.focus();
  }, [open, activeIndex]);

  const openMenu = () => {
    if (disabled) return;
    updatePosition();
    setActiveIndex(selectedIndex >= 0 ? selectedIndex : 0);
    setOpen(true);
  };

  const choose = (option: SelectOption) => {
    if (option.disabled) return;
    onChange(option.value);
    setOpen(false);
    triggerRef.current?.focus();
  };

  const onMenuKeyDown = (event: ReactKeyboardEvent) => {
    if (!open) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      setOpen(false);
      triggerRef.current?.focus();
      return;
    }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      if (options.length === 0) return;
      setActiveIndex((index) => {
        const step = event.key === 'ArrowDown' ? 1 : -1;
        return (index + step + options.length) % options.length;
      });
      return;
    }
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      const option = options[activeIndex];
      if (option) choose(option);
    }
  };

  return (
    <div ref={rootRef} className={`relative inline-flex min-w-0 ${className}`}>
      <button
        ref={triggerRef}
        type="button"
        aria-label={ariaLabel}
        aria-haspopup="listbox"
        aria-expanded={open}
        title={ariaLabel}
        data-testid={testId}
        disabled={disabled}
        onClick={() => (open ? setOpen(false) : openMenu())}
        onKeyDown={(event) => {
          if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            event.preventDefault();
            openMenu();
          }
        }}
        className={`inline-flex min-w-0 flex-1 items-center justify-between gap-1.5 rounded-md border border-hairline-strong text-ink outline-none transition-colors duration-80 ease-eg hover:border-ink-tertiary focus-visible:ring-2 focus-visible:ring-[var(--eg-focus-ring-color)] disabled:pointer-events-none disabled:opacity-40 ${sizeClasses[size]} ${toneClasses[tone]}`}
      >
        <span className="truncate">{selected?.label ?? placeholder}</span>
        <ChevronDown className="size-3.5 shrink-0 text-ink-tertiary" aria-hidden />
      </button>

      {open && position
        ? createPortal(
            <div
              ref={menuRef}
              role="listbox"
              aria-label={ariaLabel}
              tabIndex={-1}
              onKeyDown={onMenuKeyDown}
              style={{
                position: 'fixed',
                left: position.left,
                top: position.top,
                width: Math.max(position.width, 160),
                maxWidth: 320,
                transform: position.up ? 'translateY(-100%)' : undefined,
              }}
              className="z-50 max-h-72 overflow-y-auto rounded-lg border border-hairline bg-surface-3 p-1 shadow-[var(--eg-shadow-dialog)]"
            >
              {options.length === 0 ? (
                <div className="px-eg-2 py-1.5 text-caption text-ink-tertiary">{emptyLabel}</div>
              ) : (
                options.map((option, index) => (
                  <button
                    key={option.value}
                    ref={(node) => {
                      optionRefs.current[index] = node;
                    }}
                    type="button"
                    role="option"
                    aria-selected={option.value === value}
                    disabled={option.disabled}
                    data-testid={testId ? `${testId}-option-${option.value}` : undefined}
                    onMouseEnter={() => setActiveIndex(index)}
                    onClick={() => choose(option)}
                    className={`flex w-full cursor-pointer select-none items-center gap-eg-2 rounded-md px-eg-2 py-1.5 text-left text-secondary outline-none disabled:pointer-events-none disabled:opacity-40 ${
                      index === activeIndex
                        ? 'bg-surface-2 text-ink'
                        : 'text-ink-muted hover:bg-surface-2 hover:text-ink'
                    }`}
                  >
                    <span className="min-w-0 flex-1 truncate">{option.label}</span>
                    {option.value === value ? (
                      <Check className="size-3.5 shrink-0 text-primary" aria-hidden />
                    ) : null}
                  </button>
                ))
              )}
            </div>,
            document.body,
          )
        : null}
    </div>
  );
}
