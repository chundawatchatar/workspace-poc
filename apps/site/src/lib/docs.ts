import { type CollectionEntry, getCollection } from 'astro:content'
import { DOC_GROUPS } from '../content.config'

export type Doc = CollectionEntry<'docs'>

/** Docs in reading order: by group, then by `order`. */
export async function sortedDocs(): Promise<Doc[]> {
  const docs = await getCollection('docs')
  const rank = (doc: Doc) => DOC_GROUPS.indexOf(doc.data.group) * 1000 + doc.data.order
  return docs.sort((a, b) => rank(a) - rank(b))
}
