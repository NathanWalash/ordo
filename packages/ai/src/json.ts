import type { z } from 'zod'
import { AiError, type CompleteRequest, type JsonSchema, type ModelProvider } from './types'

/**
 * Pull a JSON value out of a model's reply: strips ```json fences and any chatter around
 * the outermost object or array. Throws a SyntaxError when nothing parses.
 */
export function parseModelJson(text: string): unknown {
  const fenced = /```(?:json|JSON)?\s*\n?([\s\S]*?)```/.exec(text)
  const body = (fenced ? fenced[1]! : text).trim()
  try {
    return JSON.parse(body)
  } catch (err) {
    const start = body.search(/[[{]/)
    const end = Math.max(body.lastIndexOf('}'), body.lastIndexOf(']'))
    if (start >= 0 && end > start) return JSON.parse(body.slice(start, end + 1))
    throw err
  }
}

function describeIssue(err: unknown): string {
  if (err && typeof err === 'object' && 'issues' in err && Array.isArray(err.issues))
    return err.issues
      .slice(0, 5)
      .map(
        (i: { path?: PropertyKey[]; message?: string }) => `${i.path?.join('.') || '(root)'}: ${i.message}`,
      )
      .join('; ')
  return err instanceof Error ? err.message : String(err)
}

export interface JsonRequest<T> extends Omit<CompleteRequest, 'schema'> {
  /** Sent to the model. */
  jsonSchema: JsonSchema
  /** Checks what comes back. Should describe the same shape as `jsonSchema`, or a stricter one. */
  validate: z.ZodType<T>
}

/**
 * Ask for JSON and check it with zod. If the reply doesn't parse or validate, ask once more with
 * the problem appended; if that fails too, throw an AiError('bad-response').
 */
export async function completeJson<T>(provider: ModelProvider, req: JsonRequest<T>): Promise<T> {
  const { jsonSchema, validate, ...rest } = req
  let prompt = rest.prompt
  for (let attempt = 0; attempt < 2; attempt++) {
    const res = await provider.complete({ ...rest, prompt, schema: jsonSchema })
    try {
      const value = res.json !== undefined ? res.json : parseModelJson(res.text)
      return validate.parse(value)
    } catch (err) {
      prompt =
        `${rest.prompt}\n\nYour previous reply could not be used (${describeIssue(err)}). ` +
        'Reply again with only a JSON value that matches the schema, and nothing else.'
    }
  }
  // The problem text can quote the reply, so it goes back to the model only, never into the error.
  throw new AiError('bad-response', "The model's reply wasn't in the expected format.")
}
