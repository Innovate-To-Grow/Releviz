import { RedirectToSignIn } from "@clerk/nextjs";

export const metadata = { title: "Login - Relevis" };

export default function Login() {
  return <RedirectToSignIn />;
}
