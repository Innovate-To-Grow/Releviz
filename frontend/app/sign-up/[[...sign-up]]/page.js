import { redirect } from "next/navigation";

export const metadata = { title: "Sign Up - Releviz" };

export default function SignUpPage() {
  redirect("/signup");
}
