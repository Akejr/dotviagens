import { redirect } from "next/navigation";

// Local development only: on Vercel, vercel.json serves /resultados from resultados.html (keeping the search).
export default async function Resultados({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(await searchParams)) for (const item of [value].flat()) if (item !== undefined) query.append(key, item);
  const qs = query.toString();
  redirect(`/resultados.html${qs ? `?${qs}` : ""}`);
}
