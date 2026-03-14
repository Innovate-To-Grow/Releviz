"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { MdPersonAdd } from "react-icons/md";
import AppButton from "@/components/ui/AppButton";
import { useAuth } from "@/components/auth/AuthContext";
import "@material/web/textfield/outlined-text-field.js";

function SignupPage() {
  const router = useRouter();
  const { signup } = useAuth();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  const handleSubmit = async () => {
    setError("");
    const errors = [];
    if (!email) errors.push("Email is required");
    if (!password || password.length < 6) errors.push("Password must be at least 6 characters");
    if (!displayName.trim()) errors.push("Display name is required");
    if (errors.length > 0) {
      setError(errors.join(" · "));
      return;
    }
    setLoading(true);
    try {
      await signup({ email, password, displayName: displayName.trim() });
      router.push("/");
    } catch (err) {
      setError(err.message || "Sign up failed");
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
            Sign Up
          </h1>
          <p style={{ color: "var(--md-sys-color-on-surface-variant)", margin: "8px 0 0 0" }}>
            Create your Relevis account
          </p>
        </div>

        <md-outlined-text-field
          label="Display Name"
          value={displayName}
          onInput={(e) => setDisplayName(e.target.value)}
          maxLength="100"
          style={{ width: "100%" }}
        ></md-outlined-text-field>

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

        <AppButton onClick={handleSubmit} disabled={loading} fullWidth icon={<MdPersonAdd />}>
          {loading ? "Creating account..." : "Sign Up"}
        </AppButton>

        <p
          style={{
            textAlign: "center",
            color: "var(--md-sys-color-on-surface-variant)",
            margin: 0,
            fontSize: "0.9rem",
          }}
        >
          Already have an account?{" "}
          <Link href="/login" style={{ color: "var(--md-sys-color-primary)" }}>
            Login
          </Link>
        </p>
      </div>
    </div>
  );
}

export default SignupPage;
