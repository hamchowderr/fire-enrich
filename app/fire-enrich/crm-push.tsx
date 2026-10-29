"use client";

import { useEffect, useState } from "react";
import { Upload } from "lucide-react";
import Button from "@/components/shared/button/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { CSVRow, EnrichmentField, RowEnrichmentResult } from "@/lib/types";

interface Mapping {
  mapped: { field: string; slug: string; label: string }[];
  unmatched: { field: string; slug: string; label: string }[];
}

interface Summary {
  mapping: Mapping;
  updated: string[];
  unchanged: string[];
  notInCrm: string[];
  failed: { email: string; error: string }[];
}

interface CrmPushProps {
  rows: CSVRow[];
  fields: EnrichmentField[];
  emailColumn?: string;
  results: Map<number, RowEnrichmentResult>;
}

/**
 * "FluentCRM" next to the CSV and JSON downloads: shows which enriched fields
 * match a contact custom field (a dry run), then writes the changed values to
 * the contacts (`POST /api/crm/push`). Renders nothing when FluentCRM is not
 * configured.
 */
export function CrmPush({ rows, fields, emailColumn, results }: CrmPushProps) {
  const [configured, setConfigured] = useState(false);
  const [open, setOpen] = useState(false);
  const [preview, setPreview] = useState<Mapping | null>(null);
  const [summary, setSummary] = useState<Summary | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/check-env")
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => setConfigured(!!data?.optional?.fluentcrm?.configured))
      .catch(() => {});
  }, []);

  if (!configured) return null;

  const pushRows = () =>
    rows.flatMap((row, index) => {
      const result = results.get(index);
      const email = (emailColumn ? row[emailColumn] : row.email)?.trim();
      if (!email || result?.status !== "completed") return [];
      const values = Object.fromEntries(
        Object.entries(result.enrichments).map(([field, e]) => [field, e.value]),
      );
      return [{ email, values }];
    });

  const call = async (dryRun: boolean, createFields = false): Promise<Summary> => {
    const res = await fetch("/api/crm/push", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        fields: fields.map((f) => ({ name: f.name, displayName: f.displayName })),
        rows: dryRun ? [] : pushRows(),
        dryRun,
        createFields,
      }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "FluentCRM push failed");
    return data;
  };

  const start = async () => {
    setOpen(true);
    setSummary(null);
    setPreview(null);
    setError(null);
    setBusy(true);
    try {
      setPreview((await call(true)).mapping);
    } catch (e) {
      setError(e instanceof Error ? e.message : "FluentCRM push failed");
    } finally {
      setBusy(false);
    }
  };

  const addFields = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      setPreview((await call(true, true)).mapping);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not add the fields");
    } finally {
      setBusy(false);
    }
  };

  const send = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      setSummary(await call(false));
    } catch (e) {
      setError(e instanceof Error ? e.message : "FluentCRM push failed");
    } finally {
      setBusy(false);
    }
  };

  const count = pushRows().length;

  return (
    <>
      <button
        onClick={start}
        className="rounded-6 px-8 py-4 gap-2 text-body-small text-accent-black bg-black-alpha-4 hover:bg-black-alpha-6 transition-colors flex items-center"
      >
        <Upload style={{ width: "14px", height: "14px" }} />
        FluentCRM
      </button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Send results to FluentCRM</DialogTitle>
            <DialogDescription>
              Enriched values go to each contact&apos;s custom fields. Only changed values are sent, an
              unknown value never clears one, and emails with no contact are skipped.
            </DialogDescription>
          </DialogHeader>

          {busy && !summary && <p className="text-body-small text-black-alpha-64">Working...</p>}
          {error && <p className="text-body-small text-red-600">{error}</p>}

          {preview && !summary && (
            <div className="space-y-3 text-body-small">
              {preview.mapped.length > 0 && (
                <div>
                  <p className="font-medium mb-1">Will update</p>
                  <ul className="list-disc pl-5">
                    {preview.mapped.map((m) => (
                      <li key={m.field}>
                        {fields.find((f) => f.name === m.field)?.displayName ?? m.field} → {m.label}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              {preview.unmatched.length > 0 && (
                <div>
                  <p className="font-medium mb-1">No custom field yet (skipped)</p>
                  <ul className="list-disc pl-5 mb-2">
                    {preview.unmatched.map((m) => (
                      <li key={m.field}>
                        {m.label} <code>{m.slug}</code>
                      </li>
                    ))}
                  </ul>
                  <Button
                    variant="secondary"
                    onClick={addFields}
                    isLoading={busy}
                    loadingLabel="Adding..."
                  >
                    Add {preview.unmatched.length} missing field{preview.unmatched.length === 1 ? "" : "s"} to FluentCRM
                  </Button>
                </div>
              )}
              <p>{count} completed row{count === 1 ? "" : "s"} to send.</p>
            </div>
          )}

          {summary && (
            <div className="space-y-1 text-body-small">
              <p>Updated: {summary.updated.length}</p>
              <p>Already up to date: {summary.unchanged.length}</p>
              <p>Not in FluentCRM (skipped): {summary.notInCrm.length}</p>
              {summary.failed.length > 0 && (
                <p className="text-red-600">
                  Failed: {summary.failed.length} ({summary.failed[0].error})
                </p>
              )}
            </div>
          )}

          <DialogFooter>
            {summary ? (
              <Button onClick={() => setOpen(false)}>Done</Button>
            ) : (
              <Button
                onClick={send}
                isLoading={busy && !!preview && preview.unmatched.length === 0}
                loadingLabel="Sending..."
                disabled={busy || !preview || preview.mapped.length === 0 || count === 0}
              >
                Send {count} contact{count === 1 ? "" : "s"}
              </Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
