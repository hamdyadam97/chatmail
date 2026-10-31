import type { SVGAttributes } from 'react';
import { cn } from '../lib/cn';

interface SpinnerProps extends SVGAttributes<SVGSVGElement> {
  size?: 'sm' | 'md' | 'lg';
}

const SIZES = { sm: 'h-4 w-4', md: 'h-6 w-6', lg: 'h-8 w-8' };

export function Spinner({ size = 'md', className, ...props }: SpinnerProps) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      role="status"
      aria-label="جارٍ التحميل"
      className={cn('animate-spin text-primary-600', SIZES[size], className)}
      {...props}
    >
      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
      <path
        className="opacity-90"
        fill="currentColor"
        d="M4 12a8 8 0 0 1 8-8v4a4 4 0 0 0-4 4H4z"
      />
    </svg>
  );
}
