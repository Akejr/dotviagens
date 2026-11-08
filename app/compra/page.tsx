import { redirect } from "next/navigation";

// Local development only: on Vercel, vercel.json serves /compra from compra.html (keeping ?ref=…).
export default async function Compra({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(await searchParams)) for (const item of [value].flat()) if (item !== undefined) query.append(key, item);
  const qs = query.toString();
  redirect(`/compra.html${qs ? `?${qs}` : ""}`);
}
