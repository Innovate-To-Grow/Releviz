import { redirect } from "next/navigation";
import LegacyAuthRedirect from "@/components/auth/LegacyAuthRedirect";

export const metadata = { title: "Sign In - Releviz" };

export function generateStaticParams() {
  return [{ "sign-in": [] }];
}

export default function SignInPage() {
  if (process.env.AMPLIFY_STATIC_EXPORT === "1") {
    return <LegacyAuthRedirect destination="/login" label="log in" />;
  }
  redirect("/login");
}
