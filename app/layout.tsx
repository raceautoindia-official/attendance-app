import type { Metadata, Viewport } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import Providers from "./providers";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "WorkLens",
  description: "See Work. Measure Productivity. Manage Smarter.",
  manifest: "/manifest.webmanifest",
  // The square MARK, not the wordmark: a favicon is 16-32px and the lettering
  // is a smudge at that size.
  //
  // Three sizes, because browsers pick badly when given one: the SVG for
  // anything that can scale it, a 96px PNG for tabs, and the .ico for the
  // older Windows browsers that still ask for it by name. apple-touch-icon is
  // its own file at 180px — iOS crops and rounds it itself, and handing it a
  // 512px image makes a home-screen icon that looks soft.
  icons: {
    icon: [
      { url: "/brand/worklens-mark.svg", type: "image/svg+xml", sizes: "any" },
      { url: "/brand/favicon-96x96.png", type: "image/png", sizes: "96x96" },
      { url: "/favicon.ico", sizes: "48x48" },
    ],
    apple: [{ url: "/brand/apple-touch-icon.png", sizes: "180x180", type: "image/png" }],
  },
  applicationName: "WorkLens",
  appleWebApp: {
    capable: true,
    statusBarStyle: "default",
    title: "WorkLens",
  },
};

export const viewport: Viewport = {
  themeColor: "#2563eb",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
      suppressHydrationWarning
    >
      <body className="min-h-full flex flex-col">
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
