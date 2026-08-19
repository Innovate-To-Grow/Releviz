import Link from "next/link";
import AppHeader from "@/components/ui/AppHeader";

export default function NotFound() {
  return (
    <>
      <AppHeader />
      <main>
        <p>404</p>
        <h1>Page not found</h1>
        <p>The page may have moved, or the link may no longer be available.</p>
        <Link href="/">Go home</Link>
      </main>
    </>
  );
}
