/**
 * Shared harness for the Firecrawl tool tests.
 *
 * A Mastra tool is called by the agent runtime, not directly, so a test has to
 * stand in for that runtime: supply the execution context the tool destructures
 * (`abortSignal`, `writer`) and narrow the `TOutput | ValidationError | void`
 * return type that `execute` is declared with. {@link runTool} does both, so
 * each test reads as one call and one assertion instead of three casts.
 */
import { noopObserve, type ToolExecutionContext } from '@mastra/core/tools';
import { vi } from 'vitest';

/**
 * The subset of a Mastra `Tool` a test needs to invoke it.
 *
 * The output is `unknown` rather than the tool's own type on purpose. This
 * project compiles with `strictNullChecks` off, so every property of a
 * zod-inferred output comes back optional and no honest result interface would
 * be assignable to it. The caller states the shape it expects instead, which is
 * the assertion the test is making anyway.
 */
interface ExecutableTool<TInput> {
  execute?: (input: TInput, context: ToolExecutionContext) => Promise<unknown>;
}

/** A `writer` that records what the tool wrote to the tool stream. */
export function recordingWriter() {
  return { write: vi.fn<(data: unknown) => Promise<void>>().mockResolvedValue(undefined) };
}

/** Every progress event the tool wrote, in order. */
export function progressEvents(writer: ReturnType<typeof recordingWriter>) {
  return writer.write.mock.calls.map(([event]) => event) as Array<{
    type: string;
    message: string;
    sourceUrl?: string;
  }>;
}

/** Call a tool's `execute` with a runtime-shaped context and its real output type. */
export function runTool<TInput, TOutput = unknown>(
  tool: ExecutableTool<TInput>,
  input: TInput,
  context: Partial<ToolExecutionContext> = {}
): Promise<TOutput> {
  return tool.execute!(input, {
    observe: noopObserve,
    ...context,
  } as ToolExecutionContext) as Promise<TOutput>;
}

/** An SDK error carrying an HTTP status, as the Firecrawl client throws. */
export function apiError(status: number, message = `HTTP ${status}`): Error & { status: number } {
  return Object.assign(new Error(message), { status });
}

/** A promise that never settles, for testing what happens while a call is in flight. */
export function never<T>(): Promise<T> {
  return new Promise<T>(() => {});
}
