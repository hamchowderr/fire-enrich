"use client";

import { useEffect, useState } from "react";

import { Card } from "@/components/ui/card";
import type { EnrichmentField } from "@/lib/types";

/** One entry of `GET /api/runs/:id/diff`'s `changes`. */
interface RunChange {
  contactEmail: string;
  field: string;
  change: "added" | "changed" | "removed";
  from: string | null;
  to: string | null;
  sources: Array<{ url: string; quote: string | null }>;
}

/**
 * "Changes since last run" for one contact in the detail modal: the values
 * that differ from the previous run of the same list, each with the new
 * value's source. Renders nothing for a run that was not recorded, the first
 * run of a list, a contact with no changes, or a failed request.
 */
export function RunChanges({
  runId,
  email,
  fields,
}: {
  runId: string | null;
  email: string | undefined;
  fields: EnrichmentField[];
}) {
  const [changes, setChanges] = useState<RunChange[]>([]);

  useEffect(() => {
    setChanges([]);
    if (!runId || !email) return;
    const controller = new AbortController();
    const contact = email.trim().toLowerCase();

    fetch(`/api/runs/${encodeURIComponent(runId)}/diff`, { signal: controller.signal })
      .then((response) => (response.ok ? response.json() : null))
      .then((body: { predecessor: string | null; changes: RunChange[] } | null) => {
        if (!body?.predecessor) return;
        setChanges(body.changes.filter((change) => change.contactEmail.trim().toLowerCase() === contact));
      })
      .catch(() => {
        // The section is optional; a failed request shows nothing.
      });

    return () => controller.abort();
  }, [runId, email]);

  if (changes.length === 0) return null;

  const label = (name: string) => fields.find((field) => field.name === name)?.displayName ?? name;
  const shown = (value: string | null) => (value === null || value === "" ? "none" : value);

  return (
    <div data-testid="run-changes">
      <div className="flex items-center gap-2 mb-4">
        <div className="h-px flex-1 bg-gray-200" />
        <h3 className="text-label-medium text-gray-900 font-semibold">Changes since last run</h3>
        <div className="h-px flex-1 bg-gray-200" />
      </div>

      <Card className="p-4 bg-gray-50 border-gray-200 rounded-md">
        <div className="space-y-3">
          {changes.map((change) => (
            <div key={change.field} className="space-y-1">
              <p className="text-body-small text-gray-800 break-words">
                <span className="text-label-medium text-gray-600">{label(change.field)}:</span>{" "}
                <span className="text-gray-500 line-through">{shown(change.from)}</span> →{" "}
                <span className="text-gray-900">{shown(change.to)}</span>
              </p>
              {change.sources[0] && (
                <a
                  href={change.sources[0].url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-body-x-small text-gray-700 hover:text-gray-900 break-all"
                >
                  {change.sources[0].url}
                </a>
              )}
            </div>
          ))}
        </div>
      </Card>
    </div>
  );
}
