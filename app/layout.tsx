import type { Metadata } from "next";
import { GeistMono } from "geist/font/mono";
import localFont from "next/font/local";
import ColorStyles from "@/components/shared/color-styles/color-styles";
import Scrollbar from "@/components/ui/scrollbar";
import { Toaster } from "sonner";
import "@/styles/main.css";

// Roboto Mono, latin subset, weights 400-500 of the variable font: the file
// Google Fonts serves for Roboto_Mono({ subsets: ["latin"], weight: ["400", "500"] }).
// It is committed so the build makes no network request. Licence: app/fonts/RobotoMono-OFL.txt.
const robotoMono = localFont({
  src: "./fonts/RobotoMono-latin-wght.woff2",
  weight: "400 500",
  style: "normal",
  display: "swap",
  variable: "--font-roboto-mono",
});

export const metadata: Metadata = {
  title: "Fire Enrich v2",
  description: "Enrich your data with AI-powered insights",
  icons: {
    icon: "/favicon.png",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <head>
        <ColorStyles />
      </head>
      <body
        className={`${GeistMono.variable} ${robotoMono.variable} font-sans text-accent-black bg-background-base overflow-x-clip`}
      >
        <main className="overflow-x-clip">{children}</main>
        <Scrollbar />
        <Toaster />
      </body>
    </html>
  );
}
