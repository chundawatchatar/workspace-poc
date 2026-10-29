import { defineCollection } from 'astro:content'
import { glob } from 'astro/loaders'
import { z } from 'astro/zod'

const docs = defineCollection({
  loader: glob({ pattern: '**/*.{md,mdx}', base: './src/content/docs' }),
  schema: z.object({
    title: z.string(),
    description: z.string(),
    group: z.enum(['Start', 'Use', 'Remote', 'Under the hood']),
    order: z.number(),
  }),
})

export const collections = { docs }

export const DOC_GROUPS = ['Start', 'Use', 'Remote', 'Under the hood'] as const
