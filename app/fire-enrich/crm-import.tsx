"use client";

import { useEffect, useState } from "react";
import { Users } from "lucide-react";
import Button from "@/components/shared/button/button";
import { CSVRow } from "@/lib/types";

interface Segment {
  id: number;
  title: string;
}

interface CrmImportProps {
  onLoad: (rows: CSVRow[], columns: string[]) => void;
}

/**
 * Load contacts from FluentCRM (a list, a tag, or all of them) as the table
 * to enrich, in place of a CSV. Renders nothing when FluentCRM is not
 * configured (`/api/crm/segments` answers 503).
 */
export function CrmImport({ onLoad }: CrmImportProps) {
  const [segments, setSegments] = useState<{ lists: Segment[]; tags: Segment[] } | null>(null);
  const [source, setSource] = useState("all");
  const [limit, setLimit] = useState(100);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/crm/segments")
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => data && setSegments(data))
      .catch(() => {});
  }, []);

  if (!segments) return null;

  const load = async () => {
    if (loading) return;
    setLoading(true);
    setError(null);
    try {
      const [kind, id] = source.split(":");
      const query = new URLSearchParams({ limit: String(limit) });
      if (kind === "list" || kind === "tag") query.set(kind, id);
      const res = await fetch(`/api/crm/contacts?${query}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Could not load contacts");
      if (data.rows.length === 0) throw new Error("No contacts match.");
      onLoad(data.rows, data.columns);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not load contacts");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="mt-4 p-4 rounded-xl border border-border-muted bg-accent-white">
      <div className="flex items-center gap-2 mb-3">
        <Users className="w-16 h-16 shrink-0" />
        <span className="font-medium text-accent-black">Or load contacts from FluentCRM</span>
      </div>
      <div className="flex flex-col md:flex-row gap-3">
        <select
          value={source}
          onChange={(e) => setSource(e.target.value)}
          className="flex-1 rounded-8 border border-border-muted bg-white px-3 py-2 text-body-small"
          aria-label="Contacts to load"
        >
          <option value="all">All contacts</option>
          {segments.lists.length > 0 && (
            <optgroup label="Lists">
              {segments.lists.map((l) => (
                <option key={`list:${l.id}`} value={`list:${l.id}`}>
                  {l.title}
                </option>
              ))}
            </optgroup>
          )}
          {segments.tags.length > 0 && (
            <optgroup label="Tags">
              {segments.tags.map((t) => (
                <option key={`tag:${t.id}`} value={`tag:${t.id}`}>
                  {t.title}
                </option>
              ))}
            </optgroup>
          )}
        </select>
        <select
          value={limit}
          onChange={(e) => setLimit(Number(e.target.value))}
          className="rounded-8 border border-border-muted bg-white px-3 py-2 text-body-small"
          aria-label="How many contacts"
        >
          {[10, 25, 100, 500, 1000].map((n) => (
            <option key={n} value={n}>
              Up to {n}
            </option>
          ))}
        </select>
        <Button onClick={load} isLoading={loading} loadingLabel="Loading..." className="inline-flex items-center">
          Load contacts
        </Button>
      </div>
      {error && <p className="mt-3 text-sm text-red-600">{error}</p>}
    </div>
  );
}
