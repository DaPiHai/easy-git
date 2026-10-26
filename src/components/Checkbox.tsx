import { Check, Minus } from 'lucide-react';

export interface CheckboxProps {
  checked: boolean;
  onChange: (next: boolean) => void;
  ariaLabel: string;
  testId?: string;
  disabled?: boolean;
  /** Partial selection (select-all control); clicking selects everything. */
  indeterminate?: boolean;
}

/** UI doc §6.2: 16px, 6px radius, primary fill with white check when on. */
export function Checkbox({
  checked,
  onChange,
  ariaLabel,
  testId,
  disabled = false,
  indeterminate = false,
}: CheckboxProps) {
  const active = checked || indeterminate;
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={indeterminate ? 'mixed' : checked}
      aria-label={ariaLabel}
      data-testid={testId}
      disabled={disabled}
      onClick={(event) => {
        event.stopPropagation();
        onChange(!checked);
      }}
      className={`flex size-4 shrink-0 items-center justify-center rounded-[6px] border transition-colors duration-80 ease-eg ${
        active ? 'border-primary bg-primary text-on-primary' : 'border-hairline-strong bg-surface-1'
      } ${disabled ? 'cursor-default opacity-40' : 'hover:border-primary'}`}
    >
      {indeterminate ? (
        <Minus className="size-3" aria-hidden />
      ) : checked ? (
        <Check className="size-3" aria-hidden />
      ) : null}
    </button>
  );
}
