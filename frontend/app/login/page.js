import { RedirectToSignIn } from "@clerk/nextjs";

export const metadata = { title: "Login - Releviz" };

export default function Login() {
  return <RedirectToSignIn />;
}
