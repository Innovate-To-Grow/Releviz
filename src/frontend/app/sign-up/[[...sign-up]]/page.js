import { redirect } from "next/navigation";
import LegacyAuthRedirect from "@/components/auth/LegacyAuthRedirect";

export const metadata = { title: "Sign Up - Releviz" };

export function generateStaticParams() {
  return [{ "sign-up": [] }];
}

export default function SignUpPage() {
  if (process.env.AMPLIFY_STATIC_EXPORT === "1") {
    return <LegacyAuthRedirect destination="/signup" label="sign up" />;
  }
  redirect("/signup");
}
