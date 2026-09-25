# Fire Enrich - AI-Powered Data Enrichment Tool

<div align="center">
  <img src="https://media4.giphy.com/media/v1.Y2lkPTc5MGI3NjExNjJwMnF2cW5zbXBhbGV6NXBpb3lkZmVhMWEwY3hmdmt3d3ZtbWc5YSZlcD12MV9pbnRlcm5hbF9naWZfYnlfaWQmY3Q9Zw/QhpbWI09KyFZ0rwD72/giphy.gif" alt="Fire Enrich Demo" width="100%" />
</div>

Turn a simple list of emails into a rich dataset with company profiles, funding data, tech stacks, and more. Powered by [Firecrawl](https://www.firecrawl.dev/) and [Mastra](https://mastra.ai/) agents.

## Technologies

- **Firecrawl**: Web scraping and content aggregation
- **Mastra**: Agents and the per-row enrichment workflow
- **Vercel AI Gateway**: One key for every model call
- **Next.js 15**: Modern React framework with App Router

## Deploy with Vercel

A deployment needs a Firecrawl API key and a Turso database. The Turso database holds business profiles, saved research plans and Mastra's workflow state. The AI Gateway needs no key on Vercel: the deployment's OIDC token authenticates it. Dolt (run history) is optional, and neither button asks for it.

The two buttons differ only in where the Turso database comes from.

**Turso from the Vercel Marketplace.** The Turso Cloud integration creates a database, or connects one it already manages in your Vercel team, and sets `TURSO_DATABASE_URL` and `TURSO_AUTH_TOKEN` on the project. The button asks for `FIRECRAWL_API_KEY` only. If the connection is given a custom prefix, the integration sets `<PREFIX>_TURSO_DATABASE_URL` and `<PREFIX>_TURSO_AUTH_TOKEN`, and the app reads that pair too.

[![Deploy with Turso from Vercel Marketplace](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https%3A%2F%2Fgithub.com%2Fhamchowderr%2Ffire-enrich&project-name=fire-enrich&repository-name=fire-enrich&env=FIRECRAWL_API_KEY&envDescription=Your%20Firecrawl%20API%20key.%20The%20Turso%20integration%20on%20this%20page%20provides%20the%20database.&envLink=https%3A%2F%2Fgithub.com%2Fhamchowderr%2Ffire-enrich%23deploy-with-vercel&stores=%5B%7B%22type%22%3A%22integration%22%2C%22integrationSlug%22%3A%22tursocloud%22%2C%22productSlug%22%3A%22database%22%2C%22protocol%22%3A%22storage%22%2C%22allowConnectExistingProduct%22%3Atrue%7D%5D)

**Your own Turso database.** For a database in an existing Turso account. The button asks for `FIRECRAWL_API_KEY`, `TURSO_DATABASE_URL` and `TURSO_AUTH_TOKEN`. `turso db show <database> --url` prints the url, and `turso db tokens create <database>` creates a token.

[![Deploy with your own Turso database](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https%3A%2F%2Fgithub.com%2Fhamchowderr%2Ffire-enrich&project-name=fire-enrich&repository-name=fire-enrich&env=FIRECRAWL_API_KEY,TURSO_DATABASE_URL,TURSO_AUTH_TOKEN&envDescription=Your%20Firecrawl%20API%20key%2C%20and%20the%20database%20url%20and%20auth%20token%20of%20your%20own%20Turso%20database.&envLink=https%3A%2F%2Fgithub.com%2Fhamchowderr%2Ffire-enrich%23deploy-with-vercel)

The production build creates the app's tables in the Turso database before the deployment serves traffic.

## Setup

### Required API Keys

| Service | Purpose | Get Key |
|---------|---------|---------|
| Firecrawl | Web scraping and content aggregation | [firecrawl.dev/app/api-keys](https://www.firecrawl.dev/app/api-keys) |
| Vercel AI Gateway | Intelligent data extraction | [vercel.com/docs/ai-gateway](https://vercel.com/docs/ai-gateway) |

### Quick Start

1. Clone this repository
2. Create a `.env.local` file with your API keys:
   ```
   FIRECRAWL_API_KEY=your_firecrawl_key
   AI_GATEWAY_API_KEY=your_ai_gateway_key
   ```
   `AI_GATEWAY_API_KEY` is for local development; on Vercel the deployment's OIDC token authenticates the gateway, so no key is set there.
3. Install dependencies: `npm install` or `yarn install`
4. Run the development server: `npm run dev` or `yarn dev`
5. Open [http://localhost:3000](http://localhost:3000)

## Example Enrichment

**Before:**
```json
{
  "email": "erez@wiz.io"
}
```

**After:**
```json
{
  "email": "erez@wiz.io",
  "companyName": "Wiz",
  "industry": "Cybersecurity",
  "employeeCount": "1001-5000",
  "yearFounded": 2020,
  "headquarters": "New York, NY",
  "fundingStage": "Series D",
  "totalRaised": "$900M",
  "website": "https://www.wiz.io",
  "sources": [
    "https://www.wiz.io/about",
    "https://techcrunch.com/2023/02/27/wiz-confirms-300m-at-a-10b-valuation-to-build-out-its-cloud-security-platform/"
  ]
}
```

## How It Works

Every row runs the `enrichRow` Mastra workflow (`lib/mastra/workflows/enrich-row.ts`):

1.  **Plan**: Field generation turns the requested fields into a research plan: groups of fields, the searches and sources to try for each, and a strategy (search, Firecrawl's hosted agent, or a browser). The plan is cached per field set.
2.  **Identify**: An agent reads the site on the email's domain to establish the company, its website and a short description.
3.  **Research**: One research agent per group fills its fields with the Firecrawl search, scrape and map tools, and reports each value with the page quote that supports it.
4.  **Stream**: Results stream to the table row by row, with the source of every value.

The chat panel asks the `chat` agent (`lib/mastra/agents/chat.ts`) about the table. It answers from the enriched data when the table holds the answer, and otherwise searches the web and cites the page it read.

### Key Features

-   **Drag & Drop CSV**: Simple, intuitive interface to get started in seconds.
-   **Customizable Fields**: Choose from a list of common data points or generate your own with natural language.
-   **Real-time Streaming**: Watch your data get enriched row-by-row via Server-Sent Events.
-   **Full Source Citations**: Every piece of data is linked back to the URL it was found on, ensuring complete transparency.
-   **Skip Common Providers**: Automatically skips personal emails (Gmail, Yahoo, etc.) to save on API calls and focus on company data.

### Configuration & Unlimited Mode

When you clone and run this repository locally, Fire Enrich automatically enables **Unlimited Mode**, removing the restrictions of the public demo. You can configure these limits in [`app/fire-enrich/config.ts`](app/fire-enrich/config.ts):

```typescript
const isUnlimitedMode = process.env.FIRE_ENRICH_UNLIMITED === 'true' || 
                       process.env.NODE_ENV === 'development';

export const FIRE_ENRICH_CONFIG = {
  CSV_LIMITS: {
    MAX_ROWS: isUnlimitedMode ? Infinity : 15,
    MAX_COLUMNS: isUnlimitedMode ? Infinity : 5,
  },
  REQUEST_LIMITS: {
    MAX_FIELDS_PER_ENRICHMENT: isUnlimitedMode ? 50 : 10,
  },
} as const;
```

## Our Open Source Philosophy

Let's be blunt: professional data enrichment services are expensive for a reason. Our goal with Fire Enrich isn't to replicate every feature of mature platforms overnight. Instead, we want to build a powerful, open-source foundation that anyone can use, understand, and contribute to.

This is just the start. By open-sourcing it, we're inviting you to join us on this journey.

-   **Add a new agent?** Fork the repo and show us what you've got.
-   **Improve a data extraction prompt?** Open a pull request.
-   **Have a new feature idea?** Start a discussion in the issues.

We believe that by building in public, we can create a tool that is more accessible, affordable, and adaptable, thanks to the collective intelligence of the open-source community.

## License

MIT License - see [LICENSE](LICENSE) file for details.

## Contributing

We welcome contributions! Please feel free to submit a Pull Request.

## Support

For questions and issues, please open an issue in this repository.
