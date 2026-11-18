import type { FieldType, LabelColor, TemplateId } from './types'

export interface TemplateField {
  name: string
  type: FieldType
  options?: { name: string; color: LabelColor }[]
  showOnCard?: boolean
}

export interface BoardTemplate {
  id: TemplateId
  name: string
  description: string
  columns: { name: string; wipLimit?: number; done?: boolean }[]
  labels: { name: string; color: LabelColor }[]
  fields: TemplateField[]
}

export const TEMPLATES: readonly BoardTemplate[] = [
  {
    id: 'simple',
    name: 'Simple',
    description: 'To do, Doing and Done.',
    columns: [{ name: 'To do' }, { name: 'Doing' }, { name: 'Done', done: true }],
    labels: [
      { name: 'Urgent', color: 'red' },
      { name: 'Waiting', color: 'yellow' },
      { name: 'Home', color: 'green' },
    ],
    fields: [],
  },
  {
    id: 'weekly',
    name: 'Weekly plan',
    description: 'A column for each day, the weekend and done.',
    columns: [
      { name: 'Monday' },
      { name: 'Tuesday' },
      { name: 'Wednesday' },
      { name: 'Thursday' },
      { name: 'Friday' },
      { name: 'Weekend' },
      { name: 'Done', done: true },
    ],
    labels: [
      { name: 'Home', color: 'green' },
      { name: 'Work', color: 'blue' },
      { name: 'Errands', color: 'orange' },
      { name: 'Health', color: 'teal' },
    ],
    fields: [
      {
        name: 'Effort',
        type: 'select',
        options: [
          { name: 'Quick', color: 'green' },
          { name: 'An hour or so', color: 'yellow' },
          { name: 'Half a day', color: 'red' },
        ],
        showOnCard: true,
      },
    ],
  },
  {
    id: 'project',
    name: 'Project',
    description: 'Backlog to done, with priority, owner and estimate fields.',
    columns: [
      { name: 'Backlog' },
      { name: 'Up next' },
      { name: 'In progress', wipLimit: 3 },
      { name: 'Review' },
      { name: 'Done', done: true },
    ],
    labels: [
      { name: 'Blocked', color: 'red' },
      { name: 'Research', color: 'purple' },
      { name: 'Admin', color: 'grey' },
      { name: 'Quick win', color: 'green' },
    ],
    fields: [
      {
        name: 'Priority',
        type: 'select',
        options: [
          { name: 'Low', color: 'grey' },
          { name: 'Medium', color: 'yellow' },
          { name: 'High', color: 'orange' },
          { name: 'Urgent', color: 'red' },
        ],
        showOnCard: true,
      },
      { name: 'Owner', type: 'person', showOnCard: true },
      { name: 'Estimate (hours)', type: 'number' },
      { name: 'Link', type: 'url' },
    ],
  },
]

export const template = (id: TemplateId): BoardTemplate => TEMPLATES.find((t) => t.id === id) ?? TEMPLATES[0]!
