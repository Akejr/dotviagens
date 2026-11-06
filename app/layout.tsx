import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "DOT Viagens",
  description: "Pesquisa voos com a DOT Viagens.",
  icons: {
    icon: "/favicon.svg",
    shortcut: "/favicon.svg",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="pt">
      <body className="antialiased">{children}</body>
    </html>
  );
}
