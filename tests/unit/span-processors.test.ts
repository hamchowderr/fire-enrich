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

  it.each([
    ['josé@acme.com', '***@acme.com'],
    ['jürgen@bücher.de', '***@bücher.de'],
    ['Zoë Ñúñez <zoë.ñúñez@acme.com>', 'Zoë Ñúñez <***@acme.com>'],
    ["o'brien@acme.com", '***@acme.com'],
    ['o’brien@acme.com', '***@acme.com'],
    ["email='jane@acme.io'", "email='***@acme.io'"],
    ["it's jane@acme.com", "it's ***@acme.com"],
    [`${'x'.repeat(70)}@acme.com`, '***@acme.com'],
    ['a.b@c.d.example.org, e@f.io', '***@c.d.example.org, ***@f.io'],
  ])('masks %j whole', (text, masked) => {
    expect(maskEmails(text)).toBe(masked);
    expect(maskEmails(masked)).toBe(masked);
  });

  it.each([
    // Cut before the `@`: the last word is masked, since it may be a local part.
    ['Contact: jane.do…[truncated]', 'Contact: ***…[truncated]'],
    ['Contact: jane%4…[truncated]', 'Contact: ***…[truncated]'],
    // Cut inside the domain, which the full pattern does not match.
    ['Contact: jane@acme.c…[truncated]', 'Contact: ***@acme.c…[truncated]'],
    ['Contact: jane%40acm…[truncated]', 'Contact: ***%40acm…[truncated]'],
    ["Contact: o'bri…[truncated]", 'Contact: ***…[truncated]'],
    // An address the cut left whole, and an already masked tail, stay as they are.
    ['Contact: jane@acme.co…[truncated]', 'Contact: ***@acme.co…[truncated]'],
    ['Contact: ***@acme.c…[truncated]', 'Contact: ***@acme.c…[truncated]'],
    ['Contact: ***…[truncated]', 'Contact: ***…[truncated]'],
  ])('masks the address a cut string ends with: %j', (text, masked) => {
    expect(maskEmails(text)).toBe(masked);
    expect(maskEmails(masked)).toBe(masked);
  });

  it('leaves the last word of a string that was not cut alone', () => {
    expect(maskEmails('Contact: jane.doe')).toBe('Contact: jane.doe');
  });

  it('runs in linear time on 16,000-character strings built to make a regex backtrack', () => {
    const worst = [
      'a'.repeat(16_000),
      `${'a'.repeat(15_999)}@`,
      `a@${'a.'.repeat(7_999)}`,
      'a%40'.repeat(4_000),
      `${'a.'.repeat(7_999)}@`,
      `${"a'".repeat(7_999)}@`,
      `${'é'.repeat(15_999)}@`,
      `x@${`${'b'.repeat(63)}.`.repeat(249)}`,
      'a@'.repeat(8_000),
      `${'a'.repeat(15_988)}…[truncated]`,
    ];
    maskEmails('warm up jane@acme.com');
    for (const text of worst) {
      const started = performance.now();
      maskEmails(text);
      // About 1 ms each on a laptop; the previous pattern took 300-750 ms on
      // several of these. The bound leaves room for a slow CI runner.
      expect(performance.now() - started).toBeLessThan(50);
    }
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

  it('mask an address that the string length cap cut in two', async () => {
    const exporter = new CaptureExporter();
    const observability = new Observability({
      configs: {
        test: {
          serviceName: 'fire-enrich-test',
          exporters: [exporter],
          // Mastra cuts strings when the span records them, before the processors run.
          serializationOptions: { maxStringLength: 40 },
          spanOutputProcessors: [emailRedactor()],
        },
      },
    });
    const instance = observability.getInstance('test')!;
    const prompt = `${'p'.repeat(33)} jane.doe@firecrawl.dev and more`;

    const span = instance.startSpan({ type: SpanType.GENERIC, name: 'cut', input: { prompt } });
    span.end();
    await observability.flush();

    expect(exporter.ended[0].input).toEqual({ prompt: `${'p'.repeat(33)} ***…[truncated]` });
    expect(JSON.stringify(exporter.events.map((event) => event.exportedSpan))).not.toMatch(/jane|\.do/);
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
