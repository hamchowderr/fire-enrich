"use client";

import { useState } from "react";
import Image from "next/image";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { ArrowLeft, ExternalLink } from "lucide-react";
import { CSVUploader } from "./csv-uploader";
import { UnifiedEnrichmentView } from "./unified-enrichment-view";
import { EnrichmentTable } from "./enrichment-table";
import { CSVRow, EnrichmentField } from "@/lib/types";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

export default function CSVEnrichmentPage() {
  const [step, setStep] = useState<"upload" | "setup" | "enrichment">("upload");
  const [csvData, setCsvData] = useState<{
    rows: CSVRow[];
    columns: string[];
  } | null>(null);
  const [emailColumn, setEmailColumn] = useState<string>("");
  const [selectedFields, setSelectedFields] = useState<EnrichmentField[]>([]);
  const [showConfigModal, setShowConfigModal] = useState(false);
  const [missingKeys, setMissingKeys] = useState<{
    firecrawl: boolean;
    gateway: boolean;
  }>({ firecrawl: false, gateway: false });

  const handleCSVUpload = async (rows: CSVRow[], columns: string[]) => {
    // Both credentials are server configuration: the routes read
    // FIRECRAWL_API_KEY and the AI Gateway credential (AI_GATEWAY_API_KEY, or
    // the deployment's OIDC token on Vercel) from the environment only, so
    // there is no key to enter here.
    const response = await fetch("/api/check-env");
    const data = await response.json();
    const hasFirecrawl = data.environmentStatus.FIRECRAWL_API_KEY;
    const hasGateway = data.environmentStatus.AI_GATEWAY_API_KEY;

    if (!hasFirecrawl || !hasGateway) {
      setMissingKeys({ firecrawl: !hasFirecrawl, gateway: !hasGateway });
      setShowConfigModal(true);
    } else {
      setCsvData({ rows, columns });
      setStep("setup");
    }
  };

  const handleStartEnrichment = (email: string, fields: EnrichmentField[]) => {
    setEmailColumn(email);
    setSelectedFields(fields);
    setStep("enrichment");
  };

  const handleBack = () => {
    if (step === "setup") {
      setStep("upload");
    } else if (step === "enrichment") {
      setStep("setup");
    }
  };

  const resetProcess = () => {
    setStep("upload");
    setCsvData(null);
    setEmailColumn("");
    setSelectedFields([]);
  };

  return (
    <div className="px-4 sm:px-6 lg:px-8 py-4 max-w-7xl mx-auto font-inter">
      <div className="flex justify-between items-center">
        <Link
          href="https://www.firecrawl.dev/?utm_source=tool-csv-enrichment"
          target="_blank"
          rel="noopener noreferrer"
        >
          <Image
            src="/firecrawl-logo-with-fire.png"
            alt="Firecrawl Logo"
            width={113}
            height={24}
          />
        </Link>
      </div>

      <div className="text-center pt-8 pb-6">
        <h1 className="text-[2.5rem] lg:text-[3.8rem] text-[#36322F] dark:text-white font-semibold tracking-tight leading-[0.9] opacity-0 animate-fade-up [animation-duration:500ms] [animation-delay:200ms] [animation-fill-mode:forwards]">
          <span className="relative px-1 text-transparent bg-clip-text bg-gradient-to-tr from-red-600 to-yellow-500 inline-flex justify-center items-center">
            Fire Enrich v2
          </span>
          <span className="block leading-[1.1] opacity-0 animate-fade-up [animation-duration:500ms] [animation-delay:400ms] [animation-fill-mode:forwards]">
            Drag, Drop, Enrich.
          </span>
        </h1>
      </div>

      {/* Main Content */}
      <div className="bg-[#FBFAF9] p-4 sm:p-6 rounded-lg shadow-sm">
        {step === "setup" && (
          <Button
            variant="code"
            size="sm"
            onClick={handleBack}
            className="mb-4 flex items-center gap-1.5"
          >
            <ArrowLeft size={16} />
            Back
          </Button>
        )}

        {step === "upload" && <CSVUploader onUpload={handleCSVUpload} />}

        {step === "setup" && csvData && (
          <UnifiedEnrichmentView
            rows={csvData.rows}
            columns={csvData.columns}
            onStartEnrichment={handleStartEnrichment}
          />
        )}

        {step === "enrichment" && csvData && (
          <>
            <div className="mb-4">
              <h2 className="text-xl font-semibold mb-1">
                Enrichment Results
              </h2>
              <p className="text-sm text-muted-foreground">
                Click on any row to view detailed information
              </p>
            </div>
            <EnrichmentTable
              rows={csvData.rows}
              fields={selectedFields}
              emailColumn={emailColumn}
            />
            <div className="mt-6 text-center">
              <Button variant="orange" onClick={resetProcess}>
                Start New Enrichment
              </Button>
            </div>
          </>
        )}
      </div>

      <footer className="py-8 text-center text-sm text-gray-600 dark:text-gray-400">
        <p>
          Powered by{" "}
          <Link
            href="https://www.firecrawl.dev"
            target="_blank"
            rel="noopener noreferrer"
            className="text-orange-600 hover:text-orange-700 dark:text-orange-400 dark:hover:text-orange-300 font-medium"
          >
            Firecrawl
          </Link>
          {" and "}
          <Link
            href="https://vercel.com/ai-gateway"
            target="_blank"
            rel="noopener noreferrer"
            className="text-orange-600 hover:text-orange-700 dark:text-orange-400 dark:hover:text-orange-300 font-medium"
          >
            the Vercel AI Gateway
          </Link>
        </p>
      </footer>

      {/* Server configuration notice */}
      <Dialog open={showConfigModal} onOpenChange={setShowConfigModal}>
        <DialogContent className="sm:max-w-md bg-white dark:bg-zinc-900">
          <DialogHeader>
            <DialogTitle>Configuration Required</DialogTitle>
            <DialogDescription>
              Enrichment needs a Firecrawl API key and access to the Vercel AI
              Gateway, both configured on the server.
            </DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-4 py-4">
            {missingKeys.firecrawl && (
              <>
                <div className="flex flex-col gap-2">
                  <p className="text-sm font-medium">Firecrawl</p>
                  <p className="text-sm text-muted-foreground">
                    Search and scrape calls use the Firecrawl API key
                    configured on the server, not in this dialog. Set
                    FIRECRAWL_API_KEY in the server&apos;s environment.
                  </p>
                </div>
                <Button
                  onClick={() =>
                    window.open("https://www.firecrawl.dev", "_blank")
                  }
                  variant="outline"
                  size="sm"
                  className="flex items-center justify-center gap-2 cursor-pointer"
                >
                  <ExternalLink className="h-4 w-4" />
                  Get a Firecrawl API key
                </Button>
              </>
            )}

            {missingKeys.gateway && (
              <>
                <div className="flex flex-col gap-2">
                  <p className="text-sm font-medium">Vercel AI Gateway</p>
                  <p className="text-sm text-muted-foreground">
                    Model calls go through the Vercel AI Gateway, which is
                    configured on the server, not in this dialog. Set
                    AI_GATEWAY_API_KEY for local development. A Vercel
                    deployment authenticates with its OIDC token when OIDC is
                    enabled, or with AI_GATEWAY_API_KEY.
                  </p>
                </div>
                <Button
                  onClick={() =>
                    window.open("https://vercel.com/docs/ai-gateway", "_blank")
                  }
                  variant="outline"
                  size="sm"
                  className="flex items-center justify-center gap-2 cursor-pointer"
                >
                  <ExternalLink className="h-4 w-4" />
                  AI Gateway documentation
                </Button>
              </>
            )}
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setShowConfigModal(false)}
            >
              Close
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
