"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { MdLogin } from "react-icons/md";
import AppButton from "@/components/ui/AppButton";
import { useAuth } from "@/components/auth/AuthContext";
import "@material/web/textfield/outlined-text-field.js";

function LoginPage() {
  const router = useRouter();
  const { login } = useAuth();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  const handleSubmit = async () => {
    setError("");
    if (!email || !password) {
      setError("Email and password are required");
      return;
    }
    setLoading(true);
    try {
      await login({ email, password });
      router.push("/");
    } catch (err) {
      setError(err.message || "Login failed");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div
      style={{
        minHeight: "100vh",
        display: "flex",
        justifyContent: "center",
        alignItems: "center",
        padding: "24px",
        boxSizing: "border-box",
      }}
    >
      <div
        className="md-card"
        style={{
          maxWidth: "420px",
          width: "100%",
          display: "flex",
          flexDirection: "column",
          gap: "24px",
        }}
      >
        <div style={{ textAlign: "center" }}>
          <h1 style={{ color: "var(--md-sys-color-primary)", margin: 0, fontSize: "1.8rem" }}>
            Login
          </h1>
          <p style={{ color: "var(--md-sys-color-on-surface-variant)", margin: "8px 0 0 0" }}>
            Sign in to your Relevis account
          </p>
        </div>

        <md-outlined-text-field
          label="Email"
          type="email"
          value={email}
          onInput={(e) => setEmail(e.target.value)}
          style={{ width: "100%" }}
        ></md-outlined-text-field>

        <md-outlined-text-field
          label="Password"
          type="password"
          value={password}
          onInput={(e) => setPassword(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && handleSubmit()}
          style={{ width: "100%" }}
        ></md-outlined-text-field>

        {error && (
          <p style={{ color: "var(--md-sys-color-error)", margin: 0, fontSize: "0.9rem" }}>
            {error}
          </p>
        )}

        <AppButton onClick={handleSubmit} disabled={loading} fullWidth icon={<MdLogin />}>
          {loading ? "Logging in..." : "Login"}
        </AppButton>

        <p
          style={{
            textAlign: "center",
            color: "var(--md-sys-color-on-surface-variant)",
            margin: 0,
            fontSize: "0.9rem",
          }}
        >
          Don&apos;t have an account?{" "}
          <Link href="/signup" style={{ color: "var(--md-sys-color-primary)" }}>
            Sign up
          </Link>
        </p>
      </div>
    </div>
  );
}

export default LoginPage;
