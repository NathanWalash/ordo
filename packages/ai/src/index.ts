// Pure parts of the AI layer: types, provider metadata, JSON handling and concurrency.
// Safe to import anywhere, including the renderer. Adapters live in '@ordo/ai/node'.
export * from './types'
export { completeJson, parseModelJson, type JsonRequest } from './json'
export { deadline, limitConcurrency, type Deadline } from './limit'
