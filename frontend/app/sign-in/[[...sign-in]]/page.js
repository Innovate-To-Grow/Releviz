import { redirect } from "next/navigation";

export const metadata = { title: "Sign In - Releviz" };

export default function SignInPage() {
  redirect("/login");
}
