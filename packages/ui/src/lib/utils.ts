import { type ClassValue, clsx } from 'clsx'
import { twMerge } from 'tailwind-merge'

/** Joins class names, letting later Tailwind classes override earlier ones (`size-4` then `size-5` gives `size-5`). */
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}
