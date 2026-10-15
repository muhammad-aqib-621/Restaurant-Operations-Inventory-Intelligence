import type { HTMLAttributes } from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '../../lib/utils';

const badgeVariants = cva('badge', {
  variants: { variant: { neutral: 'badge--neutral', success: 'badge--success', amber: 'badge--amber' } },
  defaultVariants: { variant: 'neutral' },
});
type BadgeProps = HTMLAttributes<HTMLSpanElement> & VariantProps<typeof badgeVariants>;

export function Badge({ variant = 'neutral', className = '', ...props }: BadgeProps) {
  return <span data-slot="badge" className={cn(badgeVariants({ variant }), className)} {...props} />;
}
