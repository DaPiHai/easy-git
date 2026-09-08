import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from 'react';

export type ButtonVariant = 'primary' | 'secondary' | 'tertiary' | 'danger' | 'inverse';
export type ButtonSize = 'sm' | 'md';

const variantClasses: Record<ButtonVariant, string> = {
  // UI doc §6.1: one primary per screen; hover lightens (dark) / darkens (light) via token.
  primary: 'bg-primary text-on-primary hover:bg-primary-hover',
  secondary:
    'bg-surface-1 border border-hairline text-ink hover:bg-surface-2 hover:border-hairline-strong',
  tertiary: 'bg-transparent text-ink-muted hover:text-ink',
  danger:
    'bg-danger-bg border border-danger-border text-danger hover:bg-git-danger hover:text-on-primary',
  inverse: 'bg-inverse-bg text-on-inverse hover:opacity-90',
};

const sizeClasses: Record<ButtonSize, string> = {
  sm: 'h-7 px-3.5',
  md: 'h-8 px-3.5',
};

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  /** Render any inline element (icon or label). */
  children?: ReactNode;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = 'secondary', size = 'md', className = '', type = 'button', children, ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type}
      className={`inline-flex select-none items-center justify-center gap-1.5 rounded-md font-ui text-secondary font-medium transition-colors duration-80 ease-eg disabled:pointer-events-none disabled:opacity-40 ${sizeClasses[size]} ${variantClasses[variant]} ${className}`}
      {...rest}
    >
      {children}
    </button>
  );
});
