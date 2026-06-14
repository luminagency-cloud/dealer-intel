import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Competitive Market Analysis",
};

/** Standalone layout for shareable report links — no auth, no nav chrome. */
export default function ReportStandaloneLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <div className="min-h-screen bg-zinc-50">
      {children}
    </div>
  );
}
