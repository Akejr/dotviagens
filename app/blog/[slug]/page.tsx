import { redirect } from "next/navigation";

// Local development only: /blog/<slug> opens the static article (on Vercel, vercel.json rewrites it).
export default async function BlogArticle({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  redirect(/^[a-z0-9-]+$/.test(slug) ? `/blog/${slug}.html` : "/blog/index.html");
}
