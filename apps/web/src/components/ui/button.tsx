import { Slot } from '@radix-ui/react-slot';
import { cva, type VariantProps } from 'class-variance-authority';
import type { ComponentPropsWithRef } from 'react';
import { cn } from '../../lib/utils';

const buttonVariants = cva('button', {
  variants: {
    variant: { primary: 'button--primary', secondary: 'button--secondary', ghost: 'button--ghost' },
    size: { default: 'button--default', small: 'button--small', icon: 'button--icon' },
  },
  defaultVariants: { variant: 'primary', size: 'default' },
});

type ButtonProps = ComponentPropsWithRef<'button'> & VariantProps<typeof buttonVariants> & {
  asChild?: boolean;
};

export function Button({ asChild = false, variant = 'primary', size = 'default', className = '', ...props }: ButtonProps) {
  const Component = asChild ? Slot : 'button';
  return <Component data-slot="button" className={cn(buttonVariants({ variant, size }), className)} {...props} />;
}
