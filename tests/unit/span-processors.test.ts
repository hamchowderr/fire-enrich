/**
 * The span output processors (lib/mastra/span-processors.ts), run by a real
 * `Observability` into an in-memory exporter: email addresses are masked and
 * page text is cut in what is exported, and the app's own values are not
 * touched.
 */
import { SpanType, type AnyExportedSpan, type TracingEvent } from '@mastra/core/observability';
import { BaseExporter, Observability } from '@mastra/observability';
import { describe, expect, it } from 'vitest';

import { emailRedactor, maskEmails, pageTextLimiter, TRACED_PAGE_CHARS } from '@/lib/mastra/span-processors';
import { createObservability } from '@/lib/mastra/tracing';

class CaptureExporter extends BaseExporter {
  name = 'capture';
  readonly events: TracingEvent[] = [];

  get ended(): AnyExportedSpan[] {
    return this.events.filter((event) => event.type === 'span_ended').map((event) => event.exportedSpan);
  }

  protected async _exportTracingEvent(event: TracingEvent): Promise<void> {
    this.events.push(event);
  }
}

function observe() {
  const exporter = new CaptureExporter();
  const observability = new Observability({
    configs: {
      test: {
        serviceName: 'fire-enrich-test',
        exporters: [exporter],
        spanOutputProcessors: [emailRedactor(), pageTextLimiter()],
      },
    },
  });
  return { exporter, observability, instance: observability.getInstance('test')! };
}

describe('maskEmails', () => {
  it('masks the local part and keeps the domain', () => {
    expect(maskEmails('Email to identify: hello@firecrawl.dev\nEmail domain: firecrawl.dev')).toBe(
      'Email to identify: ***@firecrawl.dev\nEmail domain: firecrawl.dev'
    );
    expect(maskEmails('Row 1 (jane.o+crm@mail.example.co.uk): ok')).toBe('Row 1 (***@mail.example.co.uk): ok');
    expect(maskEmails('https://x.test/?to=jane%40example.com')).toBe('https://x.test/?to=***%40example.com');
  });

  it('is idempotent and leaves text without an address alone', () => {
    const once = maskEmails('a@b.io and c.d@e.org');
    expect(maskEmails(once)).toBe(once);
    expect(maskEmails('no address @ here, or foo@bar')).toBe('no address @ here, or foo@bar');
  });
});

describe('emailRedactor and pageTextLimiter on exported spans', () => {
  it('mask every email in input, output, metadata and attributes, and object keys', async () => {
    const { exporter, observability, instance } = observe();
    const input = {
      email: 'hello@firecrawl.dev',
      rowIndex: 3,
      row: { 'owner@firecrawl.dev': 'x', note: 'cc jane@firecrawl.dev' },
      prompt: 'Contact email: hello@firecrawl.dev',
    };

    const span = instance.startSpan({
      type: SpanType.TOOL_CALL,
      name: "tool: 'search'",
      input,
      metadata: { contact: 'hello@firecrawl.dev' },
      attributes: { toolDescription: 'from hello@firecrawl.dev' },
    });
    span.end({ output: { messages: [{ role: 'user', content: 'Email to identify: hello@firecrawl.dev' }] } });
    await observability.flush();

    const [exported] = exporter.ended;
    expect(exported.input).toEqual({
      email: '***@firecrawl.dev',
      rowIndex: 3,
      row: { '***@firecrawl.dev': 'x', note: 'cc ***@firecrawl.dev' },
      prompt: 'Contact email: ***@firecrawl.dev',
    });
    expect(exported.output).toEqual({ messages: [{ role: 'user', content: 'Email to identify: ***@firecrawl.dev' }] });
    expect(exported.metadata).toMatchObject({ contact: '***@firecrawl.dev' });
    expect(exported.attributes).toMatchObject({ toolDescription: 'from ***@firecrawl.dev' });

    // No event of the span, start or end, carried an address.
    const all = JSON.stringify(exporter.events.map((event) => event.exportedSpan));
    expect(all).not.toMatch(/hello@|jane@|owner@/);
    // The app's value is untouched.
    expect(input.email).toBe('hello@firecrawl.dev');
    await observability.shutdown();
  });

  it('cut page text under `markdown` keys, once, and leave other strings alone', async () => {
    const { exporter, observability, instance } = observe();
    const page = 'p'.repeat(40_000);
    const output = {
      url: 'https://www.firecrawl.dev/',
      markdown: page,
      results: [{ url: 'https://a.test', markdown: 's'.repeat(1_600) }],
      description: 'd'.repeat(3_000),
    };

    const span = instance.startSpan({ type: SpanType.TOOL_CALL, name: "tool: 'scrape'", input: { url: output.url } });
    // The update exports the span once; the end exports the same, already cut
    // output again, which must not be cut a second time.
    span.update({ output });
    span.end();
    await observability.flush();

    const exported = exporter.ended[0].output as typeof output;
    expect(exported.markdown).toBe(`${'p'.repeat(TRACED_PAGE_CHARS)}… [page text cut for the trace: 40000 chars]`);
    expect(exported.results[0].markdown).toHaveLength(1_600);
    expect(exported.description).toHaveLength(3_000);
    expect(output.markdown).toHaveLength(40_000);
    await observability.shutdown();
  });
});

describe('createObservability', () => {
  it('runs the email redactor and the page text limiter, and caps strings at 16,000 characters', async () => {
    const observability = createObservability({ enabled: true, sampleRate: 1, retentionDays: 14 })!;
    const config = observability.getDefaultInstance()!.getConfig();

    const names = config.spanOutputProcessors.map((processor) => processor.name);
    expect(names).toEqual(expect.arrayContaining(['email-redactor', 'page-text-limiter']));
    expect(config.serializationOptions).toEqual({ maxStringLength: 16_000 });
    await observability.shutdown();
  });
});
