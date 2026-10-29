import { resetPassword } from './reset-password'
import type { RenderedMail } from './template'
import { verifyEmail } from './verify-email'

/** Every email the server can send. Add a template file, then add it here. */
const templateList = [verifyEmail, resetPassword] as const

type Template = (typeof templateList)[number]

/** The name of a known email, such as `verifyEmail`. */
export type TemplateName = Template['name']

/** The data the template called `Name` renders from. */
export type TemplateData<Name extends TemplateName> = Parameters<Extract<Template, { name: Name }>['render']>[0]

const templates = new Map<string, Template>(templateList.map((template) => [template.name, template]))

/** Renders the template called `name` with `data`. */
export function renderTemplate<Name extends TemplateName>(name: Name, data: TemplateData<Name>): RenderedMail {
  const template = templates.get(name)
  if (!template) throw Object.assign(new Error('unknown template'), { code: 'UNKNOWN_TEMPLATE' })
  // TypeScript can't relate `data` to the template looked up by `name`, though the types of `send` guarantee it.
  return (template.render as (data: TemplateData<Name>) => RenderedMail)(data)
}
