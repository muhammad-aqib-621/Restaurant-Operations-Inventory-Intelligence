import type { HTMLAttributes } from 'react';
import { cn } from '../../lib/utils';

export function Card({ className = '', ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div data-slot="card" className={cn('card', className)} {...props} />;
}

export function CardHeader({ className = '', ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div data-slot="card-header" className={cn('card-header', className)} {...props} />;
}
